const KEY = 'tongmu-guest-nickname'
export function getGuestNickname(): string {
  try {
    return localStorage.getItem(KEY)?.trim().slice(0, 40) ?? ''
  } catch {
    return ''
  }
}
export function saveGuestNickname(nickname: string): void {
  try {
    localStorage.setItem(KEY, nickname.trim().slice(0, 40))
  } catch {
    /* The current join still works. */
  }
}
