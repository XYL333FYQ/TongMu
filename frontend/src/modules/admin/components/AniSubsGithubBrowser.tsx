import { t, useTranslation } from '@/i18n'
import { useState, useCallback } from 'react'
import { Folder, FileJson, ChevronRight, Globe, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import { proxyGitHubUrl } from '@/utils/githubCdn'

interface GithubContentItem {
  name: string
  path: string
  type: 'file' | 'dir' | string
  download_url?: string | null
  html_url?: string
}

interface AniSubsGithubBrowserProps {
  existingUrls: string[]
  onAddUrls: (urls: string[]) => void
  repoUrl?: string
  defaultPath?: string
  title?: string
}

function parseGithubRepoUrl(input: string): {
  owner: string
  repo: string
  path: string
  branch: string
} | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // 支持 https://github.com/owner/repo/tree/branch/path
  const treeMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/
  )
  if (treeMatch) {
    return {
      owner: treeMatch[1],
      repo: treeMatch[2],
      branch: treeMatch[3],
      path: treeMatch[4],
    }
  }

  // 支持 https://github.com/owner/repo 或 https://github.com/owner/repo/path
  const repoMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(.*))?$/
  )
  if (repoMatch) {
    return {
      owner: repoMatch[1],
      repo: repoMatch[2],
      branch: 'main',
      path: repoMatch[3] || '',
    }
  }

  // 支持 owner/repo/path 简写
  const shortMatch = trimmed.match(/^([^/]+)\/([^/]+)(?:\/(.*))?$/)
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      branch: 'main',
      path: shortMatch[3] || '',
    }
  }

  return null
}

function buildRawUrl(
  owner: string,
  repo: string,
  branch: string,
  path: string
): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${branch}/${path}`
}

export function AniSubsGithubBrowser({
  existingUrls,
  onAddUrls,
  repoUrl = 'https://github.com/creamycake-anime/ani-subs',
  defaultPath = '',
  title = 'Import subscriptions from GitHub',
}: AniSubsGithubBrowserProps) {
  useTranslation()

  const [repoInput, setRepoInput] = useState(repoUrl)
  const [currentPath, setCurrentPath] = useState(defaultPath)
  const [items, setItems] = useState<GithubContentItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState<{
    owner: string
    repo: string
    branch: string
  } | null>(null)

  const fetchContents = useCallback(
    async (path: string) => {
      const info = parseGithubRepoUrl(repoInput)
      if (!info) {
        setError(
          t('Use a GitHub repository URL: https://github.com/owner/repo')
        )
        return
      }

      setLoading(true)
      setError('')
      try {
        const apiPath = path ? `/${encodeURIComponent(path)}` : ''
        const url = proxyGitHubUrl(
          `https://api.github.com/repos/${info.owner}/${info.repo}/contents${apiPath}?ref=${info.branch}`
        )
        const res = await fetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
          },
        })
        if (!res.ok) {
          const data = (await res.json()) as { message?: string }
          throw new Error(
            data.message ||
              t('Request failed ({value1}).', { value1: res.status })
          )
        }
        const data = (await res.json()) as GithubContentItem[]
        setItems(
          Array.isArray(data)
            ? data.sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name)
                return a.type === 'dir' ? -1 : 1
              })
            : []
        )
        setParsed({ owner: info.owner, repo: info.repo, branch: info.branch })
        setCurrentPath(path)
      } catch (err) {
        console.error('[AniSubsGithubBrowser] fetch error:', err)
        setError(
          err instanceof Error
            ? err.message
            : t('Could not load repository contents.')
        )
        setItems([])
      } finally {
        setLoading(false)
      }
    },
    [repoInput]
  )

  const handleAddFile = (item: GithubContentItem) => {
    if (!parsed) return
    const rawUrl = proxyGitHubUrl(
      item.download_url ||
        buildRawUrl(parsed.owner, parsed.repo, parsed.branch, item.path)
    )
    if (existingUrls.includes(rawUrl)) {
      message.info(t('This subscription already exists.'))
      return
    }
    onAddUrls([rawUrl])
    message.success(t('Subscription added.'))
  }

  const handleAddAllJson = () => {
    if (!parsed) return
    const jsonFiles = items.filter(
      (item) => item.type === 'file' && item.name.endsWith('.json')
    )
    if (jsonFiles.length === 0) {
      message.info(t('No JSON files in this folder.'))
      return
    }
    const newUrls = jsonFiles
      .map((item) =>
        proxyGitHubUrl(
          item.download_url
            ? item.download_url
            : buildRawUrl(parsed.owner, parsed.repo, parsed.branch, item.path)
        )
      )
      .filter((url) => !existingUrls.includes(url))
    if (newUrls.length === 0) {
      message.info(t('These JSON subscriptions already exist.'))
      return
    }
    onAddUrls(newUrls)
    message.success(
      t('Added  {value1}  subscriptions', { value1: newUrls.length })
    )
  }

  const isJsonFile = (item: GithubContentItem) =>
    item.type === 'file' && item.name.endsWith('.json')

  return (
    <div className="glass-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Globe
          className="h-4 w-4"
          style={{ color: 'var(--md-sys-color-primary)' }}
        />
        <Text className="text-sm font-medium">{title}</Text>
      </div>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void fetchContents(currentPath)
            }
          }}
          placeholder="https://github.com/owner/repo"
          className="flex-1 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchContents(currentPath)}
          loading={loading}
          disabled={loading}
        >
          {t('Browse')}
        </Button>
      </div>

      {error && (
        <Paragraph type="danger" className="m-0 mb-3 text-xs">
          {t(error)}
        </Paragraph>
      )}

      {parsed && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
          <span>
            {parsed.owner}/{parsed.repo}
          </span>
          {currentPath && (
            <>
              <ChevronRight className="h-3 w-3" />
              <span>{currentPath}</span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {currentPath && (
              <button
                type="button"
                onClick={() => {
                  setCurrentPath(defaultPath)
                  void fetchContents(defaultPath)
                }}
                className="text-[var(--md-sys-color-primary)] hover:underline"
              >
                {t('Back to root folder')}
              </button>
            )}
            <button
              type="button"
              onClick={handleAddAllJson}
              className="text-[var(--md-sys-color-primary)] hover:underline"
            >
              {t('Add all JSON files')}
            </button>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="max-h-[240px] overflow-y-auto rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)]">
          {items.map((item) => {
            const isJson = isJsonFile(item)
            const alreadyAdded = item.download_url
              ? existingUrls.includes(item.download_url)
              : false

            return (
              <div
                key={item.path}
                className="flex items-center justify-between gap-2 border-b border-[var(--md-sys-color-outline-variant)] px-3 py-2 last:border-b-0 hover:bg-[var(--md-sys-color-surface-container-high)]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {item.type === 'dir' ? (
                    <Folder className="h-4 w-4 flex-shrink-0 text-[var(--md-sys-color-primary)]" />
                  ) : (
                    <FileJson
                      className={cn(
                        'h-4 w-4 flex-shrink-0',
                        isJson
                          ? 'text-[var(--md-sys-color-tertiary)]'
                          : 'text-[var(--md-sys-color-on-surface-variant)]'
                      )}
                    />
                  )}
                  <span className="truncate text-sm" title={item.name}>
                    {item.name}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {item.type === 'dir' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setCurrentPath(item.path)
                        void fetchContents(item.path)
                      }}
                    >
                      {t('Open')}
                    </Button>
                  ) : isJson ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      icon={<Plus className="h-3 w-3" />}
                      onClick={() => handleAddFile(item)}
                      disabled={alreadyAdded}
                    >
                      {alreadyAdded ? t('Added ') : t('Add')}
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
