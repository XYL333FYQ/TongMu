const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const source = (relative) =>
  fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8')

let currentUser
let locale = 'en'

function icon() {
  return React.createElement('svg', { 'aria-hidden': 'true' })
}

const icons = new Proxy({}, { get: () => icon })
const Button = ({
  children,
  icon: leadingIcon,
  variant,
  size,
  loading,
  ...props
}) => React.createElement('button', props, leadingIcon, children)
const Avatar = ({ alt }) => React.createElement('span', { 'aria-label': alt })
const Input = (props) => React.createElement('input', props)
const Text = ({ children }) => React.createElement('span', null, children)
const Paragraph = ({ children }) => React.createElement('p', null, children)
const Modal = ({ open, title, children, footer }) =>
  open
    ? React.createElement(
        'div',
        { role: 'dialog', 'aria-label': title },
        children,
        footer
      )
    : null
const ConfirmModal = () => null
const Spinner = ({ tip }) => React.createElement('span', null, tip)
const Tag = ({ children }) => React.createElement('span', null, children)

function loadComponent(relative, extraImports = {}) {
  const output = ts.transpileModule(source(relative), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    (name) => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
      if (name === 'react-router-dom') {
        return extraImports[name] || require('react-router-dom')
      }
      if (name === 'lucide-react') return icons
      if (name === '@/i18n')
        return {
          t: (copy, params) => translateMessage(locale, copy, zh, params),
          canonicalProductMessage: (copy) => translateMessage('en', copy, zh),
          getLocale: () => locale,
          useTranslation: () => ({ locale }),
        }
      if (name === '@/i18n/core.zh') return { coreZh }
      if (name === '@/components/ui/Button') return { Button }
      if (name === '@/components/ui/Avatar') return { Avatar }
      if (name === '@/components/ui/Input') return { Input }
      if (name === '@/components/ui/Modal') return { Modal, ConfirmModal }
      if (name === '@/components/ui/Spinner') return { Spinner }
      if (name === '@/components/ui/Tag') return { Tag }
      if (name === '@/components/ui/Typography') return { Paragraph, Text }
      if (name === '@/components/ui/message') {
        return { message: { error() {}, success() {}, warning() {} } }
      }
      if (name === '@/store/authStore') {
        return {
          useAuthStore: (selector) =>
            selector ? selector({ user: currentUser, setUser() {} }) : {},
        }
      }
      if (name === '@/store/systemSettingsStore') {
        return {
          useSystemSettingsStore: () => ({ betaFeaturesEnabled: false }),
        }
      }
      if (name === '@/modules/room/watch-together/resolveSource') {
        return {
          getBilibiliQrCode: async () => ({}),
          pollBilibiliQrCode: async () => ({}),
          getBilibiliUserInfo: async () => null,
          logoutBilibili: async () => {},
          loginBilibiliWithCookie: async () => {},
          buildBilibiliImageProxyUrl: (value) => value,
        }
      }
      if (name === '@/modules/mounts/MountManager') {
        return {
          default: () =>
            React.createElement('div', { 'data-testid': 'mount-manager' }),
        }
      }
      if (name === '@/modules/server-files/ServerFileManager') {
        return {
          default: ({ showHeading = true }) =>
            React.createElement('div', {
              'data-testid': 'server-file-manager',
              'data-show-heading': String(showHeading),
            }),
        }
      }
      if (name === '@/modules/server-files/BilibiliDownloadModal') {
        return { BilibiliDownloadModal: () => null }
      }
      if (name === '@/pages/profile/AccountEditor') {
        return { AccountEditor: () => null }
      }
      if (name === '@/pages/profile/avatarUrl')
        return { buildAvatarUrl: () => undefined }
      if (name === '@/lib/api')
        return { apiFetch: async () => ({ json: async () => ({}) }) }
      if (name === './avatarUrl') return { buildAvatarUrl: () => undefined }
      if (name === '@/lib/errorMessage')
        return loadComponent('lib/errorMessage.ts', {
          '@/modules/player/services/media-redaction': loadComponent(
            'modules/player/services/media-redaction.ts'
          ),
        })
      if (name in extraImports) return extraImports[name]
      throw new Error(`Unexpected import: ${name}`)
    },
    loaded,
    loaded.exports
  )
  return loaded.exports
}

const { translateMessage } = loadComponent('i18n/translation.ts')
const { coreZh } = loadComponent('i18n/core.zh.ts')
const { pagesZh } = loadComponent('i18n/pages.zh.ts')
const { componentsZh } = loadComponent('i18n/components.zh.ts')
const { modulesZh } = loadComponent('i18n/modules.zh.ts')
const zh = { ...componentsZh, ...coreZh, ...modulesZh, ...pagesZh }

const ProfilePage = loadComponent('pages/ProfilePage.tsx', {
  'react-router-dom': {
    useLocation: () => ({ pathname: '/profile', hash: '' }),
    useNavigate: () => () => {},
  },
}).default
const AccountEditor = loadComponent(
  'pages/profile/AccountEditor.tsx'
).AccountEditor

function render(element) {
  return renderToStaticMarkup(element)
}

function renderProfile(role) {
  currentUser = { id: `id-${role}`, username: `${role}-account`, role }
  return render(React.createElement(ProfilePage))
}

test('ordinary users and root retain account, media, and role-gated server-file entries', () => {
  const userHtml = renderProfile('user')
  const adminHtml = renderProfile('admin')
  const rootHtml = renderProfile('root')

  for (const html of [userHtml, adminHtml, rootHtml]) {
    assert.match(html, /Your account/)
    assert.match(html, /Edit profile &amp; security/)
    assert.doesNotMatch(html, /Appearance/)
    assert.match(html, /Your sources/)
    assert.match(html, /data-testid="mount-manager"/)
    assert.match(html, /Bilibili account/)
  }
  assert.doesNotMatch(
    userHtml,
    /Server files|data-testid="server-file-manager"/
  )
  assert.doesNotMatch(
    adminHtml,
    /Server files|data-testid="server-file-manager"/
  )
  assert.match(rootHtml, /Server files/)
  assert.match(rootHtml, /data-testid="server-file-manager"/)
  assert.match(rootHtml, /data-show-heading="false"/)
})

test('account editor keeps password security for users and username changes root-only', () => {
  currentUser = { id: 'id-user', username: '普通用户', role: 'user' }
  const userHtml = render(
    React.createElement(AccountEditor, { user: currentUser, onClose() {} })
  )
  currentUser = { id: 'id-admin', username: 'admin', role: 'admin' }
  const adminHtml = render(
    React.createElement(AccountEditor, { user: currentUser, onClose() {} })
  )
  currentUser = { id: 'id-root', username: 'root', role: 'root' }
  const rootHtml = render(
    React.createElement(AccountEditor, { user: currentUser, onClose() {} })
  )

  assert.match(userHtml, /Change password/)
  assert.doesNotMatch(userHtml, /Change username/)
  assert.match(adminHtml, /Change password/)
  assert.doesNotMatch(adminHtml, /Change username/)
  assert.match(rootHtml, /Change password/)
  assert.match(rootHtml, /Change username/)
})

test('Chinese and English profile copy preserve account identity and role-gated sources', () => {
  currentUser = { id: 'account-42', username: '朋友 Alice', role: 'user' }
  try {
    locale = 'zh'
    const chinese = render(React.createElement(ProfilePage))
    assert.match(chinese, /个人账号/)
    assert.match(chinese, /用户编号：/)
    assert.match(chinese, /朋友 Alice/)
    assert.match(chinese, /account-42/)
    assert.match(chinese, /编辑资料与安全/)
    assert.match(chinese, /哔哩哔哩账号/)
    assert.match(chinese, /正在加载…/)
    assert.doesNotMatch(chinese, /Server files|服务器文件/)

    locale = 'en'
    const english = render(React.createElement(ProfilePage))
    assert.match(english, /Your account/)
    assert.match(english, /朋友 Alice/)
    assert.match(english, /Bilibili account/)
    assert.match(english, /Loading…/)
    assert.doesNotMatch(english, /个人账号|正在加载…/)
  } finally {
    locale = 'en'
  }
})

test('Chinese security modal localizes labels and placeholders without changing root-only controls', () => {
  try {
    locale = 'zh'
    const user = { id: 'account-42', username: '朋友 Alice', role: 'user' }
    const ordinary = render(
      React.createElement(AccountEditor, { user, onClose() {} })
    )
    assert.match(ordinary, /aria-label="资料与安全"/)
    assert.match(ordinary, /修改密码/)
    assert.match(ordinary, /placeholder="当前密码"/)
    assert.match(ordinary, /placeholder="至少 4 个字符"/)
    assert.match(ordinary, /aria-label="朋友 Alice"/)
    assert.doesNotMatch(ordinary, /修改用户名/)

    const root = render(
      React.createElement(AccountEditor, {
        user: { ...user, role: 'root' },
        onClose() {},
      })
    )
    assert.match(root, /修改用户名/)
    assert.match(root, /placeholder="请输入新用户名。"/)
  } finally {
    locale = 'en'
  }
})

test('appearance remains one global menu with no duplicate profile control', () => {
  const header = source('components/Header.tsx')
  const profile = source('pages/ProfilePage.tsx')
  const menu = source('components/AppearanceMenu.tsx')
  const theme = source('store/themeStore.ts')

  assert.equal((header.match(/<AppearanceMenu\s*\/>/g) || []).length, 1)
  assert.doesNotMatch(profile, /外观设置|<Palette/)
  assert.doesNotMatch(
    profile,
    /useThemeStore|setDark|setRadius|setGlassStrength/
  )
  assert.match(menu, /addEventListener\('tongmu:open-appearance'/)
  assert.match(menu, /useThemeStore\(\)/)
  assert.match(theme, /name: 'zcontrol-theme-storage'/)
  assert.doesNotMatch(profile, /ProfilePreferences/)
})

test('legacy settings and preferences URLs still resolve to their real destinations', () => {
  const app = source('App.tsx')
  const settings = source('pages/SettingsPage.tsx')
  const profile = source('pages/ProfilePage.tsx')

  assert.match(app, /<Route path="\/settings" element={<SettingsPage \/>} \/>/)
  assert.match(
    app,
    /<RequireAuth forbiddenRoles=\{\['guest'\]\}>\s*<ProfilePage \/>/
  )
  assert.match(
    settings,
    /user && user\.role !== 'guest' \? '\/profile#preferences' : '\/'/
  )
  assert.match(profile, /location\.hash !== '#preferences'/)
  assert.match(profile, /tongmu:open-appearance/)
})
