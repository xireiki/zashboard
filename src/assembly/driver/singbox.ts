import { getSingboxClient, probeSingboxChannel } from '@/api/singbox/client'
import type { StreamHandle } from '@/api/singbox/streams'
import { subscribeStream } from '@/api/singbox/subscriptions'
import { activeConnections } from '@/assembly/connections'
import { LOG_LEVEL, NOT_CONNECTED, PROXY_TYPE } from '@/constant'
import {
  ConnectionEventType,
  LogLevel as PbLogLevel,
  type ConnectionEvents,
  type Group,
  type GroupItem,
  type Groups,
  type OutboundList,
  type Connection as PbConnection,
  type Log as PbLog,
  type Status,
} from '@/gen/daemon/started_service_pb'
import { automaticDisconnection, iconReflectList, speedtestTimeout } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import type { Config, Connection, Log, Proxy } from '@/types'
import { shallowRef, watch } from 'vue'
import { apiVersion } from '../backend'
import { defaultConfig } from '../config'
import {
  getLatencyFromHistory,
  proxyGroupList,
  proxyMap,
  proxyProviederList,
} from '../proxies/state'
import type {
  ConfigDriver,
  ConnectionAccessor,
  ConnectionsDriver,
  ConnectionsPayload,
  Driver,
  LogsDriver,
  MemorySample,
  MetricsDriver,
  ProxiesDriver,
  ProxiesPayload,
  RulesDriver,
  Stream,
  Subscription,
  SystemDriver,
  TrafficSample,
} from './types'

const asSingbox = (connection: Connection) => connection as unknown as PbConnection

const asConnection = (connection: PbConnection): Connection =>
  ({ ...connection, downloadSpeed: 0, uploadSpeed: 0 }) as unknown as Connection

const splitHostPort = (value: string): [string, string] => {
  if (!value) return ['', '']
  const idx = value.lastIndexOf(':')
  if (idx === -1) return [value, '']

  let host = value.slice(0, idx)
  const port = value.slice(idx + 1)

  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }

  return [host, port]
}

const getNetwork = (c: PbConnection) => {
  const [, destinationPort] = splitHostPort(c.destination)

  if ((destinationPort === '443' || c.domain) && c.network === 'udp') {
    return 'quic'
  }

  return c.network
}

const getHostname = (c: PbConnection) => c.domain || splitHostPort(c.destination)[0]

const accessor: ConnectionAccessor = {
  chains: (connection) => {
    const c = asSingbox(connection)

    return c.chainList.length ? c.chainList : [c.outbound].filter(Boolean)
  },
  download: (connection) => Number(asSingbox(connection).downlinkTotal),
  upload: (connection) => Number(asSingbox(connection).uplinkTotal),
  start: (connection) => Number(asSingbox(connection).createdAt),
  rule: (connection) => asSingbox(connection).rule,
  rulePayload: () => '',
  sourceIP: (connection) => splitHostPort(asSingbox(connection).source)[0],
  sourcePort: (connection) => splitHostPort(asSingbox(connection).source)[1],
  network: (connection) => getNetwork(asSingbox(connection)),
  networkType: (connection) => {
    const c = asSingbox(connection)

    return `${c.inboundType} | ${getNetwork(c)}`
  },
  hostname: (connection) => getHostname(asSingbox(connection)),
  host: (connection) => {
    const c = asSingbox(connection)
    const [, destinationPort] = splitHostPort(c.destination)
    const host = getHostname(c)

    if (host.includes(':')) {
      return `[${host}]:${destinationPort}`
    }
    return `${host}:${destinationPort}`
  },
  process: (connection) => {
    const processInfo = asSingbox(connection).processInfo
    const processPath = processInfo?.processPath ?? ''

    return processInfo?.packageNames[0] || processPath.replace(/^.*[/\\](.*)$/, '$1') || '-'
  },
  destination: (connection) => {
    const c = asSingbox(connection)

    return splitHostPort(c.destination)[0] || c.domain
  },
  inboundUser: (connection) => {
    const c = asSingbox(connection)

    return c.user || c.inbound || '-'
  },
  sniffHost: (connection) => asSingbox(connection).domain,
  remoteAddress: (connection) => asSingbox(connection).destination,
  isDirect: (connection) => asSingbox(connection).outboundType.toLowerCase() === PROXY_TYPE.Direct,
  protocol: (connection) => asSingbox(connection).protocol,
  outboundType: (connection) => asSingbox(connection).outboundType,
  fromOutbound: (connection) => asSingbox(connection).fromOutbound,
  smartBlock: () => undefined,
}

const subscribeConnections = (): Stream<ConnectionsPayload> => {
  const data = shallowRef<ConnectionsPayload>()
  const conns = new Map<string, Connection>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const emit = () => {
    timer = null
    data.value = { connections: Array.from(conns.values()) }
  }
  const scheduleEmit = () => {
    if (timer) return
    timer = setTimeout(emit, 100)
  }

  const handle = subscribeStream<ConnectionEvents>('connections', (msg) => {
    if (msg.reset) {
      conns.clear()
    }
    for (const event of msg.events) {
      switch (event.type) {
        case ConnectionEventType.CONNECTION_EVENT_NEW:
          if (event.connection && event.connection.closedAt <= 0n) {
            conns.set(event.id, asConnection(event.connection))
          }
          break
        case ConnectionEventType.CONNECTION_EVENT_UPDATE: {
          if (event.connection) {
            if (event.connection.closedAt <= 0n) conns.set(event.id, asConnection(event.connection))
          } else {
            const prev = conns.get(event.id)
            if (prev) {
              const s = asSingbox(prev)
              conns.set(
                event.id,
                asConnection({
                  ...s,
                  uplinkTotal: s.uplinkTotal + event.uplinkDelta,
                  downlinkTotal: s.downlinkTotal + event.downlinkDelta,
                }),
              )
            }
          }
          break
        }
        case ConnectionEventType.CONNECTION_EVENT_CLOSED:
          conns.delete(event.id)
          break
        default:
          break
      }
    }
    scheduleEmit()
  })

  return {
    data,
    close: () => {
      if (timer) clearTimeout(timer)
      handle.close()
    },
  }
}

let groups = new Map<string, Group>()
let outbounds = new Map<string, GroupItem>()
let handles: StreamHandle[] = []
let sessionKey = ''
let ready: Promise<void> | null = null

type URLTestWaiter = {
  resolve: () => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const urlTestWaiters = new Set<URLTestWaiter>()

const resolveURLTestWaiters = () => {
  for (const waiter of urlTestWaiters) {
    clearTimeout(waiter.timer)
    waiter.resolve()
  }
  urlTestWaiters.clear()
}

const rejectURLTestWaiters = (reason: Error) => {
  for (const waiter of urlTestWaiters) {
    clearTimeout(waiter.timer)
    waiter.reject(reason)
  }
  urlTestWaiters.clear()
}

const waitForURLTestResult = (timeout: number) => {
  let waiter!: URLTestWaiter
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        urlTestWaiters.delete(waiter)
        reject(new Error('sing-box URL test result timeout'))
      },
      Math.max(5000, timeout) + 1000,
    )

    waiter = { resolve, reject, timer }
    urlTestWaiters.add(waiter)
  })

  return {
    promise,
    cancel: () => {
      clearTimeout(waiter.timer)
      urlTestWaiters.delete(waiter)
    },
  }
}

const rebuild = () => {
  const proxies: Record<string, Proxy> = {}

  for (const item of outbounds.values()) {
    proxies[item.tag] = nodeToProxy(item)
  }
  for (const group of groups.values()) {
    for (const item of group.items) {
      if (!proxies[item.tag]) proxies[item.tag] = nodeToProxy(item)
    }
  }
  for (const group of groups.values()) {
    proxies[group.tag] = {
      name: group.tag,
      type: group.type,
      now: group.selected,
      all: group.items.map((i) => i.tag),
      selectable: group.selectable,
      history: [],
      extra: {},
      icon: '',
    }
  }
  for (const group of groups.values()) {
    for (const item of group.items) {
      const node = proxies[item.tag]
      if (node && !node.all?.length && item.urlTestDelay > 0) {
        node.history = getHistoryFromItem(item)
      }
    }
  }
  for (const iconReflect of iconReflectList.value) {
    const node = proxies[iconReflect.name]
    if (node) node.icon = iconReflect.icon
  }

  proxyMap.value = proxies
  proxyGroupList.value = Array.from(groups.values())
    .filter((g) => g.items.length)
    .map((g) => g.tag)
  proxyProviederList.value = []
}

const nodeToProxy = (item: GroupItem): Proxy => {
  return {
    name: item.tag,
    type: item.type,
    now: '',
    history: getHistoryFromItem(item),
    extra: {},
    icon: '',
  }
}

const getHistoryFromItem = (item: GroupItem): Proxy['history'] =>
  item.urlTestDelay > 0
    ? [
        {
          time: new Date(Number(item.urlTestTime) * 1000).toISOString(),
          delay: item.urlTestDelay,
        },
      ]
    : []

const closeStreams = () => {
  handles.forEach((h) => h.close())
  handles = []
  rejectURLTestWaiters(new Error('sing-box proxy stream closed'))
  sessionKey = ''
  ready = null
}

const stopProxies = () => {
  closeStreams()
  groups = new Map()
  outbounds = new Map()
}

const ensureSession = () => {
  const backend = activeBackend.value
  const client = getSingboxClient()?.client
  if (!backend || backend.type !== 'singbox' || !client) {
    stopProxies()
    return
  }
  if (sessionKey === backend.uuid && handles.length) return

  stopProxies()
  sessionKey = backend.uuid

  let resolveReady!: () => void
  let resolved = false
  ready = new Promise<void>((r) => (resolveReady = r))

  handles = [
    subscribeStream<Groups>('groups', (msg) => {
      groups = new Map()
      for (const g of msg.group) groups.set(g.tag, g)
      rebuild()
      if (!resolved) {
        resolved = true
        resolveReady()
      } else {
        resolveURLTestWaiters()
      }
    }),
    subscribeStream<OutboundList>('outbounds', (msg) => {
      outbounds = new Map()
      for (const o of msg.outbounds) outbounds.set(o.tag, o)
      rebuild()
    }),
  ]
}

watch(activeBackend, (backend) => {
  if (backend?.type !== 'singbox') stopProxies()
})

const runURLTest = async (outboundTag: string, timeout = speedtestTimeout.value) => {
  ensureSession()
  if (ready) await ready

  const client = getSingboxClient()?.client
  if (!client) return

  const result = waitForURLTestResult(timeout)
  try {
    await Promise.all([client.uRLTest({ outboundTag }), result.promise])
  } finally {
    result.cancel()
  }
}

const proxies: ProxiesDriver = {
  fetch: async () => {
    ensureSession()
    if (ready) await ready
    rebuild()

    return { proxies: proxyMap.value, providers: [] } satisfies ProxiesPayload
  },
  select: async (group, name) => {
    const client = getSingboxClient()?.client
    const proxyGroup = proxyMap.value[group]
    if (!client || proxyGroup?.selectable === false) return

    await client.selectOutbound({ groupTag: group, outboundTag: name })

    const group0 = groups.get(group)
    if (group0) {
      group0.selected = name
      rebuild()
    }

    if (automaticDisconnection.value) {
      activeConnections.value
        .filter((c) => accessor.chains(c).includes(group))
        .forEach((c) => client.closeConnection({ id: c.id }).catch(() => {}))
    }
  },
  clearFixed: async () => undefined,
  testNode: async (name, _url, timeout) => {
    await runURLTest(name, timeout)
    return getLatencyFromHistory(proxyMap.value[name]?.history)
  },
  testProviderNode: async (_provider, name, _url, timeout) => {
    await runURLTest(name, timeout)
    return getLatencyFromHistory(proxyMap.value[name]?.history)
  },
  testGroup: async (group, _url, timeout) => {
    await runURLTest(group, timeout)

    const result: Record<string, number> = {}
    const items = groups.get(group)?.items ?? []
    for (const item of items) {
      result[item.tag] = item.urlTestDelay || NOT_CONNECTED
    }
    return result
  },
  updateProvider: async () => undefined,
  healthCheckProvider: async () => undefined,
  fetchSmartWeights: async () => ({}),
  flushSmartWeights: async () => undefined,
}

const rules: RulesDriver = {
  fetch: async () => ({ rules: [], providers: [] }),
  updateProvider: async () => undefined,
  toggleDisabled: async () => undefined,
}

const config: ConfigDriver = {
  fetch: async () => {
    const client = getSingboxClient()?.client
    if (!client) return { ...defaultConfig }

    const status = await client.getClashModeStatus({})
    return {
      ...defaultConfig,
      mode: status.currentMode,
      'mode-list': status.modeList,
      modes: status.modeList,
    } satisfies Config
  },
  patch: async (cfg) => {
    if (typeof cfg.mode !== 'string') return
    const client = getSingboxClient()?.client
    if (client) await client.setClashMode({ mode: cfg.mode })
  },
  reload: async () => undefined,
  load: async () => undefined,
  updateGeoData: async () => undefined,
  flushFakeIP: async () => undefined,
  flushDNSCache: async () => undefined,
  queryDNS: async () => {
    throw new Error('unsupported')
  },
}

const logLevelToType = (level: PbLogLevel): Log['type'] => {
  switch (level) {
    case PbLogLevel.PANIC:
      return LOG_LEVEL.Panic
    case PbLogLevel.FATAL:
      return LOG_LEVEL.Fatal
    case PbLogLevel.ERROR:
      return LOG_LEVEL.Error
    case PbLogLevel.WARN:
      return LOG_LEVEL.Warning
    case PbLogLevel.DEBUG:
      return LOG_LEVEL.Debug
    case PbLogLevel.TRACE:
      return LOG_LEVEL.Trace
    default:
      return LOG_LEVEL.Info
  }
}

const logLevelFilterFromParam = (level?: string): PbLogLevel | null | undefined => {
  switch (level?.toLowerCase()) {
    case 'panic':
      return PbLogLevel.PANIC
    case 'fatal':
      return PbLogLevel.FATAL
    case 'error':
      return PbLogLevel.ERROR
    case 'warning':
    case 'warn':
      return PbLogLevel.WARN
    case 'info':
      return PbLogLevel.INFO
    case 'debug':
      return PbLogLevel.DEBUG
    case 'trace':
      return PbLogLevel.TRACE
    case 'silent':
      return null
    default:
      return undefined
  }
}

const logs: LogsDriver = {
  subscribe: (level, onBatch): Subscription => {
    const levelFilter = logLevelFilterFromParam(level)

    const handle = subscribeStream<PbLog>('logs', (msg) => {
      const batch: Log[] = []
      for (const m of msg.messages) {
        if (levelFilter === null || (levelFilter !== undefined && m.level > levelFilter)) continue
        batch.push({ type: logLevelToType(m.level), payload: m.message })
      }
      if (batch.length) onBatch(batch)
    })

    return { close: () => handle.close() }
  },
}

const connections: ConnectionsDriver = {
  accessor,
  subscribe: subscribeConnections,
  disconnect: async (id) => {
    const client = getSingboxClient()?.client
    if (client) await client.closeConnection({ id })
  },
  disconnectAll: async () => {
    const client = getSingboxClient()?.client
    if (client) await client.closeAllConnections({})
  },
  block: async () => undefined,
}

const system: SystemDriver = {
  probe: (backend, timeout, signal) => probeSingboxChannel(backend, timeout, signal),
  fetchVersion: async () => {
    const client = getSingboxClient()?.client
    if (!client) return 'sing-box'
    const v = await client.getVersion({})
    apiVersion.value = v.apiVersion
    return v.version.includes('sing-box') ? v.version : `sing-box ${v.version}`
  },
  upgradeCore: async () => undefined,
  restartCore: async () => undefined,
  upgradeUI: async () => undefined,
  getStorage: async () => ({}),
  setStorage: async () => undefined,
  deleteStorage: async () => undefined,
}

type StatusListener = (status: Status) => void

const statusListeners = new Set<StatusListener>()
let statusHandle: StreamHandle | null = null
let latestStatus: Status | null = null

const ensureSharedStatusStream = () => {
  if (!statusHandle) {
    statusHandle = subscribeStream<Status>('status', (status) => {
      latestStatus = status
      statusListeners.forEach((listener) => listener(status))
    })
  }
}

const createMetricStream = <T>(map: (status: Status) => T): Stream<T> => {
  const data = shallowRef<T>()
  const listener: StatusListener = (status) => {
    data.value = map(status)
  }

  statusListeners.add(listener)
  ensureSharedStatusStream()
  if (latestStatus) listener(latestStatus)

  return {
    data,
    close: () => {
      statusListeners.delete(listener)
      if (statusListeners.size === 0) {
        statusHandle?.close()
        statusHandle = null
        latestStatus = null
      }
    },
  }
}

const metrics: MetricsDriver = {
  traffic: () =>
    createMetricStream<TrafficSample>((status) => ({
      down: Number(status.downlink),
      up: Number(status.uplink),
      downTotal: Number(status.downlinkTotal),
      upTotal: Number(status.uplinkTotal),
    })),
  memory: () =>
    createMetricStream<MemorySample>((status) => ({
      inuse: Number(status.memory),
      goroutines: status.goroutines,
    })),
  fetchRuntimeStats: async () => {
    throw new Error('unsupported')
  },
}

export const singboxDriver: Driver = {
  type: 'singbox',
  system,
  metrics,
  proxies,
  rules,
  config,
  logs,
  connections,
}
