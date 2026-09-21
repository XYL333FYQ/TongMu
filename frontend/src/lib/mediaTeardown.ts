/** 房间关闭或 Socket 断线时，通知当前房间内的媒体模块停止本机播放。 */
export const ROOM_MEDIA_TEARDOWN_EVENT = 'tongmu:room-media-teardown'

export interface RoomMediaTeardownDetail {
  /** true 彻底释放媒体；false 仅暂停，等待 Socket 重连后同步恢复。 */
  full: boolean
}

export function dispatchRoomMediaTeardown(full: boolean): void {
  window.dispatchEvent(
    new CustomEvent<RoomMediaTeardownDetail>(ROOM_MEDIA_TEARDOWN_EVENT, {
      detail: { full },
    })
  )
}
