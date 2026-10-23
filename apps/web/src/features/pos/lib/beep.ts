/**
 * Counter feedback tones (settings.pos.sound): a short high beep when a scan is added, a low
 * double buzz when a code is unknown — the cashier hears it without looking at the screen.
 */
let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null
  try {
    ctx ??= new window.AudioContext()
    return ctx
  } catch {
    return null
  }
}

function tone(frequency: number, ms: number, delayMs = 0): void {
  const a = audio()
  if (!a) return
  try {
    const osc = a.createOscillator()
    const gain = a.createGain()
    osc.type = 'square'
    osc.frequency.value = frequency
    gain.gain.value = 0.04
    osc.connect(gain)
    gain.connect(a.destination)
    const start = a.currentTime + delayMs / 1000
    osc.start(start)
    osc.stop(start + ms / 1000)
  } catch {
    // audio blocked until a user gesture: stay silent
  }
}

export function beepOk(enabled: boolean): void {
  if (enabled) tone(1760, 60)
}

export function beepError(enabled: boolean): void {
  if (!enabled) return
  tone(220, 120)
  tone(196, 160, 160)
}
