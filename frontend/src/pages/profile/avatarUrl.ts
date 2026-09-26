/** 构建头像完整 URL（后端返回相对路径，前端拼接 API_URL） */
export function buildAvatarUrl(
  avatar: string | null | undefined,
  role?: string
): string | undefined {
  if (!avatar) {
    // root 默认头像是前端静态资源，使用相对路径由前端服务器提供
    if (role === 'root') {
      return '/root-avatar.jpg'
    }
    return undefined
  }
  if (avatar.startsWith('http://') || avatar.startsWith('https://'))
    return avatar
  // 上传的头像存储在后端，通过 /uploads 路径访问
  // 使用相对路径，由前端服务器（Vite/Nginx/frontend-server）代理到后端
  return avatar
}
