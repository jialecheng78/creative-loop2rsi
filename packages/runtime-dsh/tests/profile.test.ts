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
})
