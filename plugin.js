import { Button, Codicon, COMPOSER_AREAS, Popover, PopoverContent, PopoverTrigger, host } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-desktop-camera'
const CAP = 1920
const STORE_KEY = 'hermes-desktop-camera:device'
const ATTACH_EVENT = 'hermes:composer-attach-images'
const FOCUS_EVENT = 'hermes:composer-focus'
const COMPOSER_SURFACE = '[data-composer-target]'

const COPY = {
  trigger: 'Camera',
  open: 'Camera',
  attach: 'Take a photo',
  snap: 'Take photo',
  close: 'Close',
  snapped: 'Added to the composer',
  copied: 'Copied to the clipboard. Press paste in the composer.',
  noCamera: 'No camera found on this device.',
  denied: 'Camera access is blocked. Allow it for this app in your system settings, then reopen.',
  busy: 'The camera is busy in another app. Close that app and try again.',
  failed: 'The camera could not be opened.'
}

const CSS = `
.hd-camera-panel{display:flex;flex-direction:column;gap:8px}
.hd-camera-head{display:flex;align-items:center;gap:6px}
.hd-camera-picker{flex:1;min-width:0;height:24px;padding:0 6px;font-size:11px;color:var(--ui-text-secondary);background:var(--ui-surface);border:1px solid var(--ui-stroke-secondary);border-radius:6px}
.hd-camera-stage{position:relative;aspect-ratio:4 / 3;overflow:hidden;border-radius:8px;background:var(--ui-surface-background)}
.hd-camera-video{display:block;width:100%;height:100%;object-fit:cover}
.hd-camera-shutter{position:absolute;left:50%;bottom:10px;transform:translateX(-50%)}
.hd-camera-note{min-height:12px;font-size:10px;color:var(--ui-text-tertiary)}
.hd-camera-empty{position:absolute;inset:0;display:grid;place-items:center;padding:14px;text-align:center;font-size:11px;color:var(--ui-text-tertiary)}
[data-slot="composer-surface"] [class~="[grid-area:controls]"] > div{display:contents}
.hd-camera-trigger{order:1;width:var(--composer-control-size);height:var(--composer-control-size);flex-shrink:0;border-radius:.375rem;color:var(--ui-text-tertiary)}
.hd-camera-trigger:hover{background:var(--chrome-action-hover);color:var(--foreground)}
[data-slot="composer-surface"] [class~="[grid-area:controls]"] > div > :last-child{order:2}
`

const listeners = new Set()

function requestOpen() {
  for (const listener of listeners) {
    listener()
  }
}

function currentTarget() {
  if (typeof document === 'undefined') {
    return 'main'
  }

  for (const surface of document.querySelectorAll(COMPOSER_SURFACE)) {
    if (!surface.closest('[data-pane-hidden]')) {
      return surface.getAttribute('data-composer-target') || 'main'
    }
  }

  return 'main'
}

const ADDED_IMAGE = 'img[src^="data:image"], img[src^="blob:"]'

function watchForImage(root, timeout) {
  return new Promise(resolve => {
    let settled = false
    let observer = null
    const finish = value => {
      if (settled) {
        return
      }

      settled = true

      if (observer) {
        observer.disconnect()
      }

      resolve(value)
    }

    observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && (node.matches(ADDED_IMAGE) || node.querySelector(ADDED_IMAGE))) {
            finish(true)
            return
          }
        }
      }
    })
    observer.observe(root, { childList: true, subtree: true })
    window.setTimeout(() => finish(false), timeout)
  })
}

async function insert(blob) {
  const target = currentTarget()
  const surface = document.querySelector('[data-composer-target="' + target + '"]')

  if (surface) {
    const attached = watchForImage(surface, 600)

    try {
      window.dispatchEvent(new CustomEvent(ATTACH_EVENT, { detail: { blobs: [blob], target } }))
      window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { target } }))
    } catch {}

    if (await attached) {
      return 'snapped'
    }
  }

  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard) {
    throw new Error('This build of the app cannot place the photo automatically')
  }

  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  return 'copied'
}

function remember(deviceId) {
  if (!deviceId) {
    return
  }

  try {
    window.localStorage.setItem(STORE_KEY, deviceId)
  } catch {}
}

function recall() {
  try {
    return window.localStorage.getItem(STORE_KEY) || ''
  } catch {
    return ''
  }
}

function problemFor(error) {
  const name = error && error.name

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return COPY.denied
  }

  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return COPY.noCamera
  }

  if (name === 'NotReadableError' || name === 'AbortError') {
    return COPY.busy
  }

  return (error && error.message) || COPY.failed
}

function Panel(props) {
  const [devices, setDevices] = useState([])
  const [active, setActive] = useState('')
  const [problem, setProblem] = useState('')
  const [note, setNote] = useState('')
  const [ready, setReady] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const generationRef = useRef(0)
  const activeRef = useRef('')

  const release = useCallback(() => {
    generationRef.current += 1
    const stream = streamRef.current
    streamRef.current = null

    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const open = useCallback(
    async deviceId => {
      release()
      const generation = generationRef.current
      setProblem('')

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true
        })

        if (generation !== generationRef.current) {
          for (const track of stream.getTracks()) {
            track.stop()
          }
          return
        }

        streamRef.current = stream

        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }

        const found = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput')

        if (generation !== generationRef.current) {
          return
        }

        setDevices(found)
        const track = stream.getVideoTracks()[0]
        const live = (track && track.getSettings && track.getSettings().deviceId) || deviceId || ''
        activeRef.current = live
        setActive(live)
        setReady(true)
        remember(live)
      } catch (error) {
        if (generation !== generationRef.current) {
          return
        }

        if (deviceId && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
          void open('')
          return
        }

        setReady(false)
        setProblem(problemFor(error))
      }
    },
    [release]
  )

  useEffect(() => () => release(), [release])

  useEffect(() => {
    void open(recall())
  }, [open])

  useEffect(() => {
    const media = navigator.mediaDevices

    if (!media || !media.addEventListener) {
      return undefined
    }

    const onDeviceChange = async () => {
      try {
        const found = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput')
        setDevices(found)

        if (activeRef.current && !found.some(device => device.deviceId === activeRef.current)) {
          void open('')
        }
      } catch {}
    }

    media.addEventListener('devicechange', onDeviceChange)
    return () => media.removeEventListener('devicechange', onDeviceChange)
  }, [open])

  const snap = useCallback(async () => {
    const video = videoRef.current

    if (!video || !video.videoWidth) {
      return
    }

    setNote('')

    try {
      const scale = Math.min(1, CAP / Math.max(video.videoWidth, video.videoHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))

      if (!blob) {
        throw new Error('The frame could not be captured')
      }

      const result = await insert(blob)
      setNote(result === 'copied' ? COPY.copied : COPY.snapped)
    } catch (error) {
      host.notifyError(error, 'The photo could not be added to the composer')
    }
  }, [])

  const options = devices.length
    ? devices.map((device, index) =>
        jsx('option', { value: device.deviceId, children: device.label || 'Camera ' + (index + 1) }, device.deviceId)
      )
    : [jsx('option', { value: '', children: COPY.noCamera }, 'none')]

  return jsxs('div', {
    className: 'hd-camera-panel',
    children: [
      jsxs('div', {
        className: 'hd-camera-head',
        children: [
          jsx('select', {
            className: 'hd-camera-picker',
            value: active,
            'aria-label': COPY.open,
            onChange: event => void open(event.target.value),
            children: options
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'micro',
            title: COPY.close,
            'aria-label': COPY.close,
            onClick: props.onClose,
            children: jsx(Codicon, { name: 'close', size: '0.75rem' })
          })
        ]
      }),
      jsxs('div', {
        className: 'hd-camera-stage',
        children: [
          jsx('video', { ref: videoRef, className: 'hd-camera-video', autoPlay: true, muted: true, playsInline: true }),
          ready ? jsx(Button, { size: 'sm', className: 'hd-camera-shutter', onClick: () => void snap(), children: COPY.snap }) : null,
          problem ? jsx('div', { className: 'hd-camera-empty', children: problem }) : null
        ]
      }),
      jsx('div', { className: 'hd-camera-note', children: note })
    ]
  })
}

function Trigger() {
  const [open, setOpen] = useState(false)
  const reveal = useCallback(() => setOpen(true), [])

  useEffect(() => {
    listeners.add(reveal)
    return () => {
      listeners.delete(reveal)
    }
  }, [reveal])

  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx(Button, {
          className: 'hd-camera-trigger',
          variant: 'ghost',
          size: 'icon',
          title: COPY.trigger,
          'aria-label': COPY.trigger,
          children: jsx(Codicon, { name: 'device-camera', size: '0.875rem' })
        })
      }),
      open
        ? jsx(PopoverContent, {
            side: 'top',
            align: 'start',
            sideOffset: 8,
            'aria-label': COPY.open,
            children: jsx(Panel, { onClose: () => setOpen(false) })
          })
        : null
    ]
  })
}

export default {
  id: ID,
  name: 'Hermes Desktop Camera',
  description: 'Snap a photo from a connected camera and drop it straight into the composer.',
  register(ctx) {
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
      ctx.onDispose(() => style.remove())
    }

    const areas = COMPOSER_AREAS || {}
    const actionArea = areas.actions || areas.leading || areas.bottom

    if (actionArea) {
      ctx.register({
        id: 'composer-button',
        area: actionArea,
        order: 120,
        render: () => jsx(Trigger, {})
      })
    }

    if (areas.attachments) {
      ctx.register({
        id: 'attach-entry',
        area: areas.attachments,
        data: {
          label: COPY.attach,
          icon: 'device-camera',
          run: () => requestOpen()
        }
      })
    }
  }
}
