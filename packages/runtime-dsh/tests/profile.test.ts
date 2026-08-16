import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('trusted DSH profile', () => {
  it('uses a local capability and mounts no model-facing system tools', async () => {
    const profile = await readFile(new URL('../profiles/studio.cordis.yml', import.meta.url), 'utf8')
    expect(profile).toContain("apiKeyEnv: CREATIVE_RSI_GATEWAY_TOKEN")
    expect(profile).toContain('baseURL: !!js process.env.CREATIVE_RSI_GATEWAY_URL')
    expect(profile).toContain("name: '@deepseek-ai/dsh-sdk-jsonrpc-server'")
    expect(profile).toContain('dshHome: !!js process.env.DSH_HOME')
    expect(profile).not.toMatch(/^\s*name:.*(?:tool-bash|tool-fs|tool-web|mcp|cordis-host-runner)/mu)
    expect(profile).not.toMatch(/^\s*name:.*(?:session-persistence|session-checkpoint)/mu)
    expect(profile).not.toContain('DSH_SESSION_ROOT')
    expect(profile).not.toContain('DEEPSEEK_API_KEY')
    expect(profile).not.toContain('https://api.deepseek.com')
  })

  it('lets Main own classified timeouts and retries only pre-stream server pressure', async () => {
    const profile = await readFile(new URL('../profiles/studio.cordis.yml', import.meta.url), 'utf8')
    expect(profile).toContain('streamIdleTimeoutMs: 660000')
    expect(profile).toContain([
      'retryPolicy:',
      '      mode: normal',
      '      maxRetries: 2',
      '      retryableCodes:',
      '        - RATE_LIMIT',
      '        - SERVER',
      '      backoff:',
      '        initialDelayMs: 500',
      '        maxDelayMs: 10000',
      '        jitterRatio: 0.1',
    ].join('\n'))
    const retryBlock = profile.slice(profile.indexOf('    retryPolicy:'), profile.indexOf('    models:'))
    expect(retryBlock).not.toMatch(/^\s*- (?:TIMEOUT|TRANSPORT)$/mu)
  })

  it('pins high thinking to 32768 tokens without treating the ceiling as success', async () => {
    const profile = await readFile(new URL('../profiles/studio.cordis.yml', import.meta.url), 'utf8')
    expect(profile).toContain('thinking: enabled')
    expect(profile).toContain('reasoningEffort: high')
    expect(profile).toContain('maxTokensAsSuccess: false')
    expect(profile.match(/^\s+maxTokens: 32768$/gmu)).toHaveLength(3)
    expect(profile).not.toContain('maxTokens: 16384')
  })
})
