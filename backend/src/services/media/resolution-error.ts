export type MediaResolutionCode =
  | 'NO_MEDIA_FOUND'
  | 'ACCESS_DENIED'
  | 'TARGET_BLOCKED'
  | 'BROWSER_BUSY'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'RESOLVE_FAILED';

const descriptions: Record<MediaResolutionCode, string> = {
  NO_MEDIA_FOUND: '未找到可验证的媒体资源',
  ACCESS_DENIED: '源站拒绝访问该页面',
  TARGET_BLOCKED: '该地址不符合安全访问规则',
  BROWSER_BUSY: '浏览器解析暂时繁忙，请稍后重试',
  CANCELLED: '媒体解析已取消',
  TIMEOUT: '媒体解析超时，请稍后重试',
  RESOLVE_FAILED: '暂时无法解析此链接，请稍后重试',
};

export class MediaResolutionError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: MediaResolutionCode) {
    super(descriptions[code]);
    this.name = 'MediaResolutionError';
    this.retryable = code === 'BROWSER_BUSY' || code === 'TIMEOUT' || code === 'RESOLVE_FAILED';
  }
}
