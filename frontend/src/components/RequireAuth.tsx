import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore, type UserRole } from '@/store/authStore'

interface RequireAuthProps {
  children: React.ReactNode
  adminOnly?: boolean
  forbiddenRoles?: UserRole[]
}

export function RequireAuth({
  children,
  adminOnly = false,
  forbiddenRoles,
}: RequireAuthProps) {
  const { isAuthenticated, user, authResolved } = useAuthStore()
  const location = useLocation()

  // 持久化的 autoLoginStatus 可能来自上一次页面生命周期；只有本页真正
  // 完成 /auth/me 或 guest 初始化后，才允许把未认证用户重定向到登录页。
  if (!isAuthenticated && !authResolved) {
    return null
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (adminOnly && user?.role !== 'root' && user?.role !== 'admin') {
    return <Navigate to="/" state={{ from: location }} replace />
  }

  if (forbiddenRoles && user?.role && forbiddenRoles.includes(user.role)) {
    return <Navigate to="/" state={{ from: location }} replace />
  }

  return <>{children}</>
}
