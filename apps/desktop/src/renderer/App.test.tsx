import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { App } from './App.js'

describe('App shell', () => {
  it('renders the four plain-language destinations before any bridge call', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('创作')
    expect(html).toContain('它学到了什么')
    expect(html).toContain('新方式')
    expect(html).toContain('版本')
    expect(html).toContain('aria-label="主要功能"')
  })

  it('does not expose implementation vocabulary in the initial interface', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).not.toMatch(/Prompt|DAG|DSH|Token/u)
  })
})
