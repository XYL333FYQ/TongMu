import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
  type Node,
} from '@xmldom/xmldom';
import {
  ManifestMappingError,
  type DashResourceKind,
  type HlsPlaylistKind,
  type HlsResourceKind,
  type ManifestMapperOptions,
  type MappedManifest,
} from './model';

export const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_MANIFEST_RESOURCES = 1000;
export const DEFAULT_MAX_MANIFEST_DEPTH = 4;

function fail(code: string, message: string): never {
  throw new ManifestMappingError(code, message);
}

function assertAbsoluteHttpUrl(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw, source);
  } catch {
    fail('INVALID_RESOURCE_URL', 'manifest 子资源 URL 无法解析');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('UNSUPPORTED_RESOURCE_SCHEME', 'manifest 子资源只允许 HTTP/HTTPS');
  }
  if (url.username || url.password) {
    fail('RESOURCE_USERINFO', 'manifest 子资源 URL 不允许 userinfo');
  }
  return url.toString();
}

function countAndMap(
  options: ManifestMapperOptions,
  state: { count: number },
  kind: HlsResourceKind | DashResourceKind,
  upstreamUrl: string,
  details: { allowRange?: boolean; template?: boolean; representationIdentity?: string } = {},
): string {
  state.count += 1;
  const limit = options.maxResources ?? DEFAULT_MAX_MANIFEST_RESOURCES;
  if (state.count > limit) fail('RESOURCE_LIMIT', `manifest 子资源超过 ${limit} 个上限`);
  const depth = options.recursiveDepth + (kind === 'Manifest' || kind === 'RecursiveManifest' ? 1 : 0);
  if (depth > (options.maxRecursiveDepth ?? DEFAULT_MAX_MANIFEST_DEPTH)) {
    fail('RECURSION_LIMIT', 'manifest 递归深度超过安全上限');
  }
  return options.mapResource({
    protocol: options.protocol,
    kind,
    upstreamUrl,
    parentResourceId: options.parentResourceId,
    recursiveDepth: depth,
    allowRange: details.allowRange ?? (kind !== 'Key' && kind !== 'Timing'),
    representationIdentity: details.representationIdentity,
    template: details.template,
  });
}

function hlsMasterTag(line: string): boolean {
  return /^#EXT-X-(?:STREAM-INF|MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|SESSION-DATA|SESSION-KEY|CONTENT-STEERING):/i.test(line);
}

export function classifyHlsPlaylist(body: string): HlsPlaylistKind {
  let master = false;
  let event = false;
  let vod = false;
  let endList = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    master ||= hlsMasterTag(line);
    endList ||= line.toUpperCase() === '#EXT-X-ENDLIST';
    const playlistType = /^#EXT-X-PLAYLIST-TYPE\s*:\s*(.+)$/i.exec(line)?.[1]?.trim();
    event ||= playlistType?.toUpperCase() === 'EVENT';
    vod ||= playlistType?.toUpperCase() === 'VOD';
  }
  if (master) return 'Master';
  if (event) return 'EventMedia';
  if (vod || endList) return 'VodMedia';
  return 'LiveMedia';
}

function hlsTagKind(line: string): HlsResourceKind {
  const upper = line.toUpperCase();
  if (upper.startsWith('#EXT-X-MEDIA:') || upper.startsWith('#EXT-X-I-FRAME-STREAM-INF:') ||
      upper.startsWith('#EXT-X-IMAGE-STREAM-INF:') || upper.startsWith('#EXT-X-RENDITION-REPORT:')) {
    return 'Manifest';
  }
  if (upper.startsWith('#EXT-X-KEY:') || upper.startsWith('#EXT-X-SESSION-KEY:')) return 'Key';
  if (upper.startsWith('#EXT-X-MAP:')) return 'Init';
  if (upper.startsWith('#EXT-X-PART:')) return 'Part';
  if (upper.startsWith('#EXT-X-PRELOAD-HINT:')) {
    const attributes = line.slice(line.indexOf(':') + 1);
    const type = /(?:^|,)\s*TYPE\s*=\s*"?([^,\"]+)/i.exec(attributes)?.[1]?.trim().toUpperCase();
    if (type === 'MAP') return 'Init';
    if (type === 'PART') return 'Part';
  }
  return 'Auxiliary';
}

function rewriteHlsQuotedUris(
  line: string,
  sourceUrl: string,
  options: ManifestMapperOptions,
  state: { count: number },
): string {
  if (!/\bURI\s*=\s*"/i.test(line)) return line;
  const kind = hlsTagKind(line);
  let found = false;
  const rewritten = line.replace(/(\bURI\s*=\s*")(.*?)(")/gi, (_match, prefix: string, raw: string, suffix: string) => {
    found = true;
    const target = assertAbsoluteHttpUrl(raw, sourceUrl);
    const mapped = countAndMap(options, state, kind, target, { allowRange: kind !== 'Key' });
    return `${prefix}${mapped}${suffix}`;
  });
  if (found && /\bURI\s*=\s*"[^\"]*$/i.test(line)) {
    fail('MALFORMED_HLS_TAG', 'HLS URI 属性缺少结束引号');
  }
  return rewritten;
}

export function rewriteHlsManifest(
  body: string,
  options: ManifestMapperOptions,
): MappedManifest<HlsPlaylistKind> {
  const playlistKind = classifyHlsPlaylist(body);
  const state = { count: 0 };
  let nextLineIsManifest = false;
  const lines = body.split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const target = assertAbsoluteHttpUrl(trimmed, options.sourceUrl);
      const kind: HlsResourceKind = nextLineIsManifest ? 'Manifest' : 'Segment';
      const mapped = countAndMap(options, state, kind, target, { allowRange: true });
      output.push(line.slice(0, line.indexOf(trimmed)) + mapped);
      nextLineIsManifest = false;
      continue;
    }
    output.push(rewriteHlsQuotedUris(line, options.sourceUrl, options, state));
    if (/^#EXT-X-STREAM-INF\s*:/i.test(trimmed)) nextLineIsManifest = true;
  }
  return { body: output.join('\n'), playlistKind, resourceCount: state.count };
}

function localName(nodeOrName: Node | string): string {
  const value = typeof nodeOrName === 'string' ? nodeOrName : (nodeOrName as Element).localName || nodeOrName.nodeName;
  return value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
}

function directChildren(node: Node, name: string): Element[] {
  const result: Element[] = [];
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child?.nodeType === 1 && localName(child) === name) result.push(child as Element);
  }
  return result;
}

function ancestors(node: Element): Element[] {
  const result: Element[] = [];
  for (let current: Node | null = node; current?.nodeType === 1; current = current.parentNode) {
    result.unshift(current as Element);
  }
  return result;
}

function effectiveDashBase(node: Element, sourceUrl: string): string {
  let base = sourceUrl;
  for (const ancestor of ancestors(node)) {
    const first = directChildren(ancestor, 'BaseURL')[0];
    const value = first?.textContent?.trim();
    if (value) base = assertAbsoluteHttpUrl(value, base);
  }
  return base;
}

function effectiveDashElement(node: Element, name: string): Element | undefined {
  const values = ancestors(node).flatMap((ancestor) => directChildren(ancestor, name));
  if (!values.length) return undefined;
  const effective = values[0].cloneNode(true) as Element;
  for (const value of values.slice(1)) {
    for (let index = 0; index < value.attributes.length; index += 1) {
      const attribute = value.attributes.item(index);
      if (attribute) effective.setAttribute(attribute.name, attribute.value);
    }
    const childNames = name === 'SegmentTemplate'
      ? ['SegmentTimeline']
      : ['Initialization', 'SegmentURL'];
    for (const childName of childNames) {
      const children = directChildren(value, childName);
      if (!children.length) continue;
      for (const oldChild of directChildren(effective, childName)) effective.removeChild(oldChild);
      for (const child of children) effective.appendChild(child.cloneNode(true));
    }
  }
  return effective;
}

function dashUrl(raw: string, base: string): string {
  return assertAbsoluteHttpUrl(raw, base);
}

function hasDashTokens(value: string): boolean {
  return /\$(?:\$|RepresentationID|Number|Time|Bandwidth)(?:%0\d+d)?\$/i.test(value);
}

function removeDirectChildren(node: Element, name: string): void {
  for (const child of directChildren(node, name)) node.removeChild(child);
}

function setMappedAttribute(
  element: Element,
  attribute: string,
  sourceUrl: string,
  kind: DashResourceKind,
  options: ManifestMapperOptions,
  state: { count: number },
  representationIdentity?: string,
): void {
  const value = element.getAttribute(attribute);
  if (!value) return;
  const target = dashUrl(value, sourceUrl);
  element.setAttribute(attribute, countAndMap(options, state, kind, target, {
    allowRange: kind !== 'Timing',
    template: hasDashTokens(value),
    representationIdentity,
  }));
}

function mapDashText(
  element: Element,
  sourceUrl: string,
  kind: DashResourceKind,
  options: ManifestMapperOptions,
  state: { count: number },
  representationIdentity?: string,
): void {
  const raw = element.textContent?.trim() ?? '';
  if (!raw) return;
  const target = dashUrl(raw, sourceUrl);
  element.textContent = countAndMap(options, state, kind, target, { representationIdentity });
}

function rewriteDashBaseUrls(
  document: Document,
  sourceUrl: string,
  options: ManifestMapperOptions,
  state: { count: number },
): void {
  const bases = Array.from(document.getElementsByTagName('*')).filter((node) => localName(node) === 'BaseURL') as Element[];
  for (const base of bases) {
    if (base.getAttribute('data-tongmu-mapped') === '1') continue;
    const raw = base.textContent?.trim() ?? '';
    if (!raw) continue;
    const target = dashUrl(raw, effectiveDashBase(base.parentNode as Element, sourceUrl));
    const parentName = localName(base.parentNode as Element);
    // BaseURL under a Representation + SegmentBase is an exact file resource.
    // Other BaseURL nodes are resolved into the concrete typed resources below;
    // removing them prevents a raw upstream URL from surviving in the output.
    if (parentName === 'Representation' && (
      effectiveDashElement(base.parentNode as Element, 'SegmentBase') ||
      (!effectiveDashElement(base.parentNode as Element, 'SegmentTemplate') &&
        !effectiveDashElement(base.parentNode as Element, 'SegmentList'))
    )) {
      base.textContent = countAndMap(options, state, 'Media', target, { allowRange: true });
      base.setAttribute('data-tongmu-mapped', '1');
    } else {
      // Keep sibling/inherited BaseURL semantics available to a DASH client,
      // but expose only a directory-scoped typed resource rather than the
      // upstream URL itself.
      base.textContent = countAndMap(options, state, 'BaseURL', target, { allowRange: true });
      base.setAttribute('data-tongmu-mapped', '1');
    }
  }
}

function rejectUnknownUriAttributes(document: Document): void {
  const known = new Set([
    'SegmentTemplate:media', 'SegmentTemplate:initialization', 'SegmentTemplate:bitstreamSwitching',
    'SegmentURL:media', 'SegmentURL:index', 'Initialization:sourceURL',
    'RepresentationIndex:sourceURL', 'BitstreamSwitching:sourceURL',
  ]);
  const elements = Array.from(document.getElementsByTagName('*')) as Element[];
  for (const element of elements) {
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (!attribute) continue;
      const name = localName(element);
      const attributeName = localName(attribute.name);
      if ((attributeName === 'href' && attribute.name.toLowerCase().includes('xlink:')) ||
          known.has(`${name}:${attributeName}`) || attributeName === 'schemeIdUri' ||
          attributeName === 'value' || attributeName === 'sourceURL' || attributeName === 'media' ||
          attributeName === 'index' || attributeName === 'initialization' || attributeName === 'bitstreamSwitching') continue;
      if (attributeName.toLowerCase().includes('url') || attributeName.toLowerCase() === 'href') {
        fail('UNSUPPORTED_DASH_URI', `不支持的 DASH URI 属性: ${name}.${attributeName}`);
      }
    }
  }
}

/**
 * A Representation BaseURL is part of the effective URL for an inherited
 * AdaptationSet SegmentTemplate. Materialize that inheritance at each
 * Representation before mapping so sibling representations keep independent
 * BaseURL scopes instead of accidentally sharing the first sibling.
 */
function materializeRepresentationScopedElements(document: Document, name: 'SegmentTemplate' | 'SegmentList'): void {
  const elements = Array.from(document.getElementsByTagName('*')) as Element[];
  const templates = elements.filter((element) => localName(element) === name);
  const representations = elements.filter((element) => localName(element) === 'Representation');
  if (!templates.length || !representations.length) return;
  const clones: Array<{ representation: Element; template: Element }> = [];
  for (const representation of representations) {
    const effective = effectiveDashElement(representation, name);
    if (effective) clones.push({ representation, template: effective });
  }
  if (!clones.length) return;
  for (const { representation, template } of clones) {
    removeDirectChildren(representation, name);
    representation.appendChild(template);
  }
  for (const template of templates) template.parentNode?.removeChild(template);
}

export function rewriteDashManifest(
  body: string,
  options: ManifestMapperOptions,
): MappedManifest<undefined> {
  if (/<!DOCTYPE|<!ENTITY|<!NOTATION/i.test(body)) fail('UNSAFE_XML', 'DASH MPD 禁止 DTD/entity');
  const document = new DOMParser().parseFromString(body, 'application/xml');
  if (!document.documentElement || localName(document.documentElement) !== 'MPD' ||
      document.getElementsByTagName('parsererror').length) {
    fail('INVALID_MPD', 'DASH MPD XML 解析失败');
  }
  const state = { count: 0 };
  rejectUnknownUriAttributes(document);
  materializeRepresentationScopedElements(document, 'SegmentTemplate');
  materializeRepresentationScopedElements(document, 'SegmentList');

  // Rewrite the complete SegmentTemplate graph, including inherited templates.
  for (const element of Array.from(document.getElementsByTagName('*')) as Element[]) {
    const name = localName(element);
    const base = effectiveDashBase(element, options.sourceUrl);
    const representation = ancestors(element).find((ancestor) => localName(ancestor) === 'Representation');
    const representationIdentity = representation?.getAttribute('id') || undefined;
    if (name === 'SegmentTemplate') {
      setMappedAttribute(element, 'media', base, 'Media', options, state, representationIdentity);
      setMappedAttribute(element, 'initialization', base, 'Initialization', options, state, representationIdentity);
      setMappedAttribute(element, 'bitstreamSwitching', base, 'BitstreamSwitching', options, state, representationIdentity);
    } else if (name === 'SegmentURL') {
      setMappedAttribute(element, 'media', base, 'Media', options, state, representationIdentity);
      setMappedAttribute(element, 'index', base, 'Index', options, state, representationIdentity);
    } else if (name === 'Initialization') {
      setMappedAttribute(element, 'sourceURL', base, 'Initialization', options, state, representationIdentity);
    } else if (name === 'RepresentationIndex') {
      setMappedAttribute(element, 'sourceURL', base, 'Index', options, state, representationIdentity);
    } else if (name === 'BitstreamSwitching') {
      setMappedAttribute(element, 'sourceURL', base, 'BitstreamSwitching', options, state, representationIdentity);
    } else if (name === 'Location') {
      mapDashText(element, base, 'Manifest', options, state, representationIdentity);
    } else if (name === 'UTCTiming') {
      const value = element.getAttribute('value');
      if (value && /^https?:\/\//i.test(value.trim())) {
        setMappedAttribute(element, 'value', base, 'Timing', options, state, representationIdentity);
      }
    }
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (!attribute || localName(attribute.name) !== 'href' || !attribute.name.toLowerCase().includes('xlink:')) continue;
      const target = dashUrl(attribute.value, base);
      element.setAttribute(attribute.name, countAndMap(options, state, 'RecursiveManifest', target, { representationIdentity }));
    }
  }

  // SegmentBase uses one file plus byte ranges. It must remain a typed media
  // handle so dash.js Range requests are still checked by the shared gateway.
  for (const segmentBase of Array.from(document.getElementsByTagName('*')).filter((node) => localName(node) === 'SegmentBase') as Element[]) {
    const owner = ancestors(segmentBase).find((ancestor) => localName(ancestor) === 'Representation')
      ?? ancestors(segmentBase).find((ancestor) => localName(ancestor) === 'AdaptationSet');
    if (!owner) fail('INVALID_SEGMENT_BASE', 'SegmentBase 缺少 Representation/AdaptationSet 作用域');
    const base = effectiveDashBase(owner, options.sourceUrl);
    const directBase = directChildren(owner, 'BaseURL')[0];
    if (!directBase) {
      const mapped = countAndMap(options, state, 'Media', base, { allowRange: true, representationIdentity: owner.getAttribute('id') || undefined });
      const baseElement = document.createElement('BaseURL');
      baseElement.textContent = mapped;
      baseElement.setAttribute('data-tongmu-mapped', '1');
      owner.insertBefore(baseElement, owner.firstChild);
    }
    const init = directChildren(segmentBase, 'Initialization')[0];
    if (init) setMappedAttribute(init, 'sourceURL', base, 'Initialization', options, state, owner.getAttribute('id') || undefined);
    const index = directChildren(owner, 'RepresentationIndex')[0] ?? directChildren(segmentBase, 'RepresentationIndex')[0];
    if (index) setMappedAttribute(index, 'sourceURL', base, 'Index', options, state, owner.getAttribute('id') || undefined);
  }

  rewriteDashBaseUrls(document, options.sourceUrl, options, state);
  for (const element of Array.from(document.getElementsByTagName('*')) as Element[]) {
    element.removeAttribute('data-tongmu-mapped');
  }
  return { body: new XMLSerializer().serializeToString(document), resourceCount: state.count };
}

export function rewriteManifest(
  body: string,
  contentType: string,
  options: ManifestMapperOptions,
): MappedManifest {
  if (/mpegurl|m3u8/i.test(contentType) || body.trimStart().startsWith('#EXTM3U')) {
    return rewriteHlsManifest(body, options);
  }
  return rewriteDashManifest(body, options);
}
