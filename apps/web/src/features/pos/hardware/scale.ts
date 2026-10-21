/**
 * Weighing scale over Web Serial (Chrome / Edge; ARCHITECTURE.md §21.8). Common Indian counter
 * scales (Essae, Avery, Atom, Phoenix…) stream ASCII frames continuously — 'ST,GS,  1.250kg',
 * 'US,NT,+0.905kg', '   1.250', 'W:1250g' — or answer a request command ('W', 'P'). The parser
 * understands these out of the box; a per-register `weight_pattern` regex (first capture group =
 * the number) and `weight_unit` cover anything else. Works fully offline (local USB/serial).
 *
 * Exported for the POS quantity dialog and the system → hardware test page:
 *   const scale = new WebSerialScale(register.settings.scale, { rememberKey: register.id })
 *   await scale.connect({ prompt: true })          // from a click (port chooser) the first time
 *   scale.subscribe((r) => setWeight(r))           // { kg_milli: 1250, stable: true, raw }
 *   await scale.connect({ prompt: false })         // later: reopens the remembered port
 */
import type { RegisterScaleSettings } from '@kadai/shared/settings'
import { storage } from '@/lib/storage'

export interface ScaleReading {
  /** Weight in grams (= milli kilograms, the qty_milli of a KG product). */
  kg_milli: number
  /** The scale reported a settled weight (frames marked 'US' are unstable). */
  stable: boolean
  /** The frame as received (trimmed). */
  raw: string
  /** Date.now() of the frame. */
  at: number
}

export type ScaleStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'error'

export type ScaleParseSettings = Pick<
  RegisterScaleSettings,
  'weight_pattern' | 'weight_unit' | 'stable_only'
>

const UNIT_RE = /(kg|kgs|g|gm|gms|lb)\b/i
const NUMBER_RE = /([+-]?\s*\d+(?:[.,]\d+)?)/

/**
 * Parses one frame into a reading (null = not a weight frame, negative, or not stable while
 * `stable_only`). Pure; unit tested with real-world frames.
 */
export function parseScaleFrame(
  frame: string,
  settings: ScaleParseSettings,
  at: number = Date.now(),
): ScaleReading | null {
  // Strip STX / ETX and other control characters some scales wrap frames in.
  // eslint-disable-next-line no-control-regex
  const raw = frame.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!raw) return null
  const upper = raw.toUpperCase()
  const unstable = /\bUS\b|\bMOTION\b|\?/.test(upper)
  const overload = /\bOL\b|OVER/.test(upper)
  if (overload) return null

  let numberText: string | undefined
  if (settings.weight_pattern) {
    try {
      const m = new RegExp(settings.weight_pattern).exec(raw)
      numberText = m?.[1]
    } catch {
      numberText = undefined
    }
  } else {
    numberText = NUMBER_RE.exec(raw)?.[1]
  }
  if (!numberText) return null
  const value = Number(numberText.replace(/\s+/g, '').replace(',', '.'))
  if (!Number.isFinite(value) || value < 0) return null

  const unitMatch = UNIT_RE.exec(raw)?.[1]?.toLowerCase()
  let unit: 'kg' | 'g' | 'lb' = settings.weight_unit
  if (unitMatch) unit = unitMatch.startsWith('k') ? 'kg' : unitMatch === 'lb' ? 'lb' : 'g'
  const grams = unit === 'kg' ? value * 1000 : unit === 'lb' ? value * 453.59237 : value
  const kgMilli = Math.round(grams)
  const stable = !unstable
  if (settings.stable_only && !stable) return null
  return { kg_milli: kgMilli, stable, raw, at }
}

/** Splits a serial stream into frames (CR / LF / ETX terminated). */
export function createFrameSplitter(onFrame: (frame: string) => void): {
  push: (text: string) => void
} {
  let buffer = ''
  return {
    push(text) {
      buffer += text
      // eslint-disable-next-line no-control-regex
      const parts = buffer.split(/[\r\n\x03]+/)
      buffer = parts.pop() ?? ''
      if (buffer.length > 256) buffer = buffer.slice(-256)
      for (const p of parts) if (p.trim()) onFrame(p)
    },
  }
}

/** Weight → quantity of a product unit (KG / G); null when the unit is not a weight. */
export function weightToQtyMilli(kgMilli: number, unit: string): number | null {
  const u = unit.toUpperCase()
  if (u === 'KG') return kgMilli
  if (u === 'G' || u === 'GM') return kgMilli * 1000
  return null
}

// ---------------------------------------------------------------------------------------------
// Web Serial (typed locally: the DOM lib has no Serial types)
// ---------------------------------------------------------------------------------------------

interface SerialPortInfoLike {
  usbVendorId?: number
  usbProductId?: number
}

interface SerialOpenOptions {
  baudRate: number
  dataBits?: number
  stopBits?: number
  parity?: 'none' | 'even' | 'odd'
  flowControl?: 'none' | 'hardware'
}

export interface SerialPortLike {
  open(options: SerialOpenOptions): Promise<void>
  close(): Promise<void>
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  getInfo(): SerialPortInfoLike
}

export interface SerialLike {
  requestPort(options?: { filters?: SerialPortInfoLike[] }): Promise<SerialPortLike>
  getPorts(): Promise<SerialPortLike[]>
}

function serialApi(): SerialLike | null {
  if (typeof navigator === 'undefined') return null
  const nav = navigator as Navigator & { serial?: SerialLike }
  return nav.serial ?? null
}

export function isWebSerialSupported(): boolean {
  return serialApi() !== null && typeof window !== 'undefined' && window.isSecureContext !== false
}

const portKey = (rememberKey: string): string => `pos.scale_port.${rememberKey}`

function isPortInfo(v: unknown): v is SerialPortInfoLike {
  return typeof v === 'object' && v !== null
}

export interface ScaleOptions {
  /** Remember the chosen port under this key (the register id). */
  rememberKey?: string
  /** Inject a Serial implementation (tests, the hardware page simulator). */
  serial?: SerialLike | null
  /** How often a request command is sent in 'on_request' mode (ms, default 400). */
  pollMs?: number
}

export class WebSerialScale {
  private port: SerialPortLike | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<(r: ScaleReading) => void>()
  private readonly statusListeners = new Set<(s: ScaleStatus, error?: unknown) => void>()
  private currentStatus: ScaleStatus
  private last: ScaleReading | null = null
  private readonly serial: SerialLike | null

  constructor(
    private readonly settings: RegisterScaleSettings,
    private readonly options: ScaleOptions = {},
  ) {
    this.serial = options.serial === undefined ? serialApi() : options.serial
    this.currentStatus = this.serial ? 'disconnected' : 'unsupported'
  }

  get status(): ScaleStatus {
    return this.currentStatus
  }

  get lastReading(): ScaleReading | null {
    return this.last
  }

  subscribe(listener: (r: ScaleReading) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: (s: ScaleStatus, error?: unknown) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(s: ScaleStatus, error?: unknown): void {
    this.currentStatus = s
    for (const l of [...this.statusListeners]) l(s, error)
  }

  /** Whether a port was chosen on this device before (connect without the chooser). */
  hasRememberedPort(): boolean {
    if (!this.options.rememberKey) return false
    return (
      storage.get<SerialPortInfoLike | null>(
        portKey(this.options.rememberKey),
        null,
        (v): v is SerialPortInfoLike | null => v === null || isPortInfo(v),
      ) !== null
    )
  }

  private async findRememberedPort(): Promise<SerialPortLike | null> {
    if (!this.serial) return null
    const ports = await this.serial.getPorts()
    if (ports.length === 0) return null
    const info = this.options.rememberKey
      ? storage.get<SerialPortInfoLike | null>(
          portKey(this.options.rememberKey),
          null,
          (v): v is SerialPortInfoLike | null => v === null || isPortInfo(v),
        )
      : null
    if (info) {
      const match = ports.find((p) => {
        const i = p.getInfo()
        return i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId
      })
      if (match) return match
    }
    return ports.length === 1 ? (ports[0] ?? null) : null
  }

  /**
   * Opens the scale. `prompt: true` shows the browser's port chooser (must run in a click
   * handler); `prompt: false` reopens a port granted before. Resolves false when no port.
   */
  async connect({ prompt }: { prompt: boolean }): Promise<boolean> {
    if (!this.serial) {
      this.setStatus('unsupported')
      return false
    }
    if (this.port) return true
    this.setStatus('connecting')
    try {
      let port = await this.findRememberedPort()
      if (!port && prompt) port = await this.serial.requestPort()
      if (!port) {
        this.setStatus('disconnected')
        return false
      }
      await port.open({
        baudRate: this.settings.baud_rate,
        dataBits: this.settings.data_bits,
        stopBits: this.settings.stop_bits,
        parity: this.settings.parity,
        flowControl: this.settings.flow_control,
      })
      this.port = port
      if (this.options.rememberKey) storage.set(portKey(this.options.rememberKey), port.getInfo())
      this.setStatus('connected')
      void this.readLoop(port)
      this.startPolling(port)
      return true
    } catch (error) {
      // The user closing the chooser is not an error.
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        this.setStatus('disconnected')
        return false
      }
      this.setStatus('error', error)
      return false
    }
  }

  private startPolling(port: SerialPortLike): void {
    if (this.settings.protocol !== 'on_request' || !this.settings.request_command) return
    const command = new TextEncoder().encode(`${this.settings.request_command}\r`)
    this.pollTimer = setInterval(() => {
      const writable = port.writable
      if (!writable || writable.locked) return
      const writer = writable.getWriter()
      void writer
        .write(command)
        .catch(() => undefined)
        .finally(() => writer.releaseLock())
    }, this.options.pollMs ?? 400)
  }

  private async readLoop(port: SerialPortLike): Promise<void> {
    const decoder = new TextDecoder()
    const splitter = createFrameSplitter((frame) => {
      const reading = parseScaleFrame(frame, this.settings)
      if (!reading) return
      this.last = reading
      for (const l of [...this.listeners]) l(reading)
    })
    while (this.port === port && port.readable) {
      const reader = port.readable.getReader()
      this.reader = reader
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) splitter.push(decoder.decode(value, { stream: true }))
        }
      } catch (error) {
        // Unplugged / framing error: report and stop.
        if (this.port === port) {
          this.port = null
          this.setStatus('error', error)
        }
        return
      } finally {
        reader.releaseLock()
        this.reader = null
      }
    }
  }

  async disconnect(): Promise<void> {
    const port = this.port
    this.port = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    try {
      await this.reader?.cancel()
    } catch {
      // already released
    }
    try {
      await port?.close()
    } catch {
      // already closed
    }
    this.setStatus(this.serial ? 'disconnected' : 'unsupported')
  }

  /** Forgets the remembered port of this register. */
  forget(): void {
    if (this.options.rememberKey) storage.remove(portKey(this.options.rememberKey))
  }
}
