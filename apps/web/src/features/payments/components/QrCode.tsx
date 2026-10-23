/**
 * QR code as inline SVG (lib/qr). Always black on white with a quiet zone, also in dark mode,
 * so every UPI app can scan it from a screen.
 */
import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { QR_MARGIN, qrMatrix } from '../lib/qr'

export interface QrCodeProps {
  value: string
  /** Accessible description, e.g. "UPI QR for ₹250.00". */
  label: string
  className?: string
}

export function QrCode({ value, label, className }: QrCodeProps) {
  const matrix = useMemo(() => qrMatrix(value), [value])
  if (!matrix) return null
  const box = matrix.size + QR_MARGIN * 2
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QR_MARGIN} ${-QR_MARGIN} ${box} ${box}`}
      shapeRendering="crispEdges"
      className={cn('block aspect-square rounded-md bg-white', className)}
      data-qr-value={value}
    >
      <rect x={-QR_MARGIN} y={-QR_MARGIN} width={box} height={box} fill="#fff" />
      <path d={matrix.path} fill="#000" />
    </svg>
  )
}
