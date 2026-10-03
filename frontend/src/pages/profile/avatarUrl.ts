/** 构建头像完整 URL（后端返回相对路径，前端拼接 API_URL） */
export function buildAvatarUrl(
  avatar: string | null | undefined
): string | undefined {
  if (!avatar) {
    return undefined
  }
  if (avatar.startsWith('http://') || avatar.startsWith('https://'))
    return avatar
  // 上传的头像存储在后端，通过 /uploads 路径访问
  // 使用相对路径，由前端服务器（Vite/Nginx/frontend-server）代理到后端
  return avatar
}
