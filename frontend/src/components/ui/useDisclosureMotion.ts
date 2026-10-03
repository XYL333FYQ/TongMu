import { useCallback, useEffect, useRef, useState } from 'react'
import { disclosureExitDuration } from './motion'

export function useDisclosureMotion() {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setClosing(false)
    setOpen(true)
  }, [])
  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setClosing(true)
    timer.current = setTimeout(() => {
      setOpen(false)
      setClosing(false)
      timer.current = null
    }, disclosureExitDuration())
  }, [])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return { open, closing, show, close }
}
