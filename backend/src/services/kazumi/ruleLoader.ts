/**
 * Kazumi 独立模块 — 规则获取与 provider 构建
 *
 * 从 GitHub（经 CDN 代理）或自定义 URL 获取 Kazumi 规则 JSON，
 * 解析并构建 provider 实例。
 */

import type { KazumiRule, KazumiSourceProvider } from './types';
import { createKazumiProvider } from './provider';
import { proxyGitHubUrl } from '../../utils/githubCdn';
import { fetchText } from '../anisubs/httpClient';
import { isBoundedRuleText, isSafeRuleUrl, MAX_RULE_SOURCES } from '../anisubs/rule-safety';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 获取 Kazumi 规则 JSON（经 PowerShell fallback 绕过 TLS 拦截） */
export async function fetchKazumiRule(url: string): Promise<KazumiRule> {
  if (!isSafeRuleUrl(url)) throw new Error('规则 URL 必须是无凭证的 HTTP/HTTPS 地址');
  const proxiedUrl = proxyGitHubUrl(url);
  const result = await fetchText(proxiedUrl, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!result.ok) {
    throw new Error(
      `获取规则失败 [${result.status}]: ${proxiedUrl}${result.error ? ` (${result.error})` : ''}`,
    );
  }
  let data: KazumiRule;
  try {
    data = JSON.parse(result.body) as KazumiRule;
  } catch {
    throw new Error('规则 JSON 解析失败');
  }
  if (typeof data.name !== 'string' || !data.name || data.name.length > 256 ||
      !isSafeRuleUrl(data.baseURL) || !isSafeRuleUrl(data.searchURL)) {
    throw new Error('规则格式不正确（缺少 name/baseURL/searchURL）');
  }
  for (const value of [data.searchList, data.searchName, data.searchResult, data.chapterRoads, data.chapterResult]) {
    if (!isBoundedRuleText(value)) throw new Error('规则选择器过长或无效');
  }
  return data;
}

/** 从规则列表构建所有 provider，返回 id → provider 映射 */
export async function buildProvidersFromRules(
  ruleUrls: string[],
): Promise<Record<string, KazumiSourceProvider>> {
  const providers: Record<string, KazumiSourceProvider> = {};

  for (let index = 0; index < Math.min(ruleUrls.length, MAX_RULE_SOURCES); index++) {
    const url = ruleUrls[index];
    if (!isSafeRuleUrl(url)) continue;
    try {
      const rule = await fetchKazumiRule(url);
      // 使用 index 保证唯一性，名称仅用于显示
      const id = `kazumi_${index}`;
      providers[id] = createKazumiProvider(id, rule);
      console.log(`[kazumi] 加载规则成功: ${rule.name} → ${id}`);
    } catch (err) {
      console.error(`[kazumi] 加载规则失败: ${url}`, err);
    }
  }

  return providers;
}
