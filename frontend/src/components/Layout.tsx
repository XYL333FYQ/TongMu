import { useEffect, useRef, type CSSProperties } from 'react'
import { useLocation } from 'react-router-dom'
import { useThemeStore } from '@/store/themeStore'
import { Header } from './Header'
import { InsecureContextBanner } from './InsecureContextBanner'
import '@/styles/tongmu-experience.css'

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const immersiveRoom = /^\/room\/[^/]+\/?$/.test(location.pathname)
  const pointerGlowRef = useRef<HTMLDivElement>(null)
  const {
    backgroundImage,
    backgroundBlur,
    backgroundOpacity,
    backgroundPositionX,
    backgroundPositionY,
    backgroundScale,
    backgroundRotate,
    reducedMotion,
    disableHoverTransform,
    cursorGlowEnabled,
    cursorGlowSize,
    cursorGlowOpacity,
  } = useThemeStore()

  // 将禁用 hover 位移的开关挂到 document.body，使通过 portal 渲染的
  // 组件（下拉、弹窗等）同样受控，实现全局生效。
  useEffect(() => {
    document.body.dataset.noHoverTransform = disableHoverTransform
      ? 'true'
      : 'false'
    return () => {
      delete document.body.dataset.noHoverTransform
    }
  }, [disableHoverTransform])

  // 外观面板和账号菜单通过 portal 渲染在 body 下，也需服从精简动画。
  useEffect(() => {
    document.body.dataset.reducedMotion = reducedMotion ? 'true' : 'false'
    return () => {
      delete document.body.dataset.reducedMotion
    }
  }, [reducedMotion])

  useEffect(() => {
    const glow = pointerGlowRef.current
    if (!glow || !cursorGlowEnabled) return

    const trackPointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      glow.style.setProperty('--tm-pointer-x', `${event.clientX}px`)
      glow.style.setProperty('--tm-pointer-y', `${event.clientY}px`)
      glow.dataset.active = 'true'
    }
    const hideGlow = () => {
      glow.dataset.active = 'false'
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') hideGlow()
    }

    window.addEventListener('pointermove', trackPointer, { passive: true })
    window.addEventListener('pointerdown', handlePointerDown, { passive: true })
    window.addEventListener('pointerleave', hideGlow)
    window.addEventListener('blur', hideGlow)
    return () => {
      glow.dataset.active = 'false'
      window.removeEventListener('pointermove', trackPointer)
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointerleave', hideGlow)
      window.removeEventListener('blur', hideGlow)
    }
  }, [cursorGlowEnabled])

  return (
    <div
      className={`tongmu-shell relative flex min-h-screen flex-col${backgroundImage ? ' tongmu-shell--custom-background' : ''}${immersiveRoom ? ' tongmu-shell--immersive' : ''}`}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-glow-enabled={cursorGlowEnabled ? 'true' : 'false'}
      style={
        {
          // 页面画布由 TongMu CSS 绘制；自定义图片模式会让画布透明。
          color: 'var(--md-sys-color-on-surface)',
          '--tm-glow-size': `${cursorGlowSize}px`,
          '--tm-glow-opacity': cursorGlowOpacity,
        } as CSSProperties
      }
    >
      {/* 仅用户主动设置背景图时显示；默认是连续浅蓝画布。 */}
      {backgroundImage && (
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            zIndex: 0,
            backgroundImage: `url(${backgroundImage})`,
            backgroundSize: 'cover',
            // 位置固定居中，偏移由 transform: translate 控制
            // （background-position 百分比在 cover 下当某方向无溢出时完全无效）
            backgroundPosition: 'center',
            filter: `blur(${backgroundBlur}px)`,
            opacity: backgroundOpacity,
            // translate 在 scale/rotate 之前，避免缩放中心扩张吃掉偏移
            // 百分比除以 2 限制最大偏移为 ±50%，防止图片完全移出视口
            transform: `translate(${backgroundPositionX / 2}%, ${backgroundPositionY / 2}%) scale(${backgroundScale}) rotate(${backgroundRotate}deg)`,
          }}
        />
      )}

      {/* 内容层：z-auto 不创建层叠上下文，允许后代 glass-card 的
          backdrop-filter 跨层采样到背景图（z-index: 0）。
          文档顺序保证内容仍在背景图之上，无需显式 z-index。 */}
      <div className="relative z-auto flex flex-1 flex-col">
        {!immersiveRoom && <Header />}
        <main key={location.pathname} className="flex min-w-0 flex-1 flex-col">
          {children}
        </main>
        <div
          ref={pointerGlowRef}
          className="tongmu-cursor-glow"
          aria-hidden="true"
          data-active="false"
        />
      </div>

      {/* HTTP 非安全上下文提示横幅：仅在生产环境 HTTP 访问时显示 */}
      <InsecureContextBanner />
    </div>
  )
}
