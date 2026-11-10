import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.tsx'

interface CapturedRegistration {
  readonly definition: {
    readonly id: string
    readonly label: () => string
    readonly inject: () => { readonly form: unknown }
  }
  readonly component: unknown
}

describe('GitHub App settings page', () => {
  it('registers a settings.section while the Host serves the namespace and releases it', () => {
    const cleanups: Array<() => void> = []
    let released = false
    let captured: CapturedRegistration | undefined
    const form = {
      getSnapshot: () => ({ status: 'loading', value: undefined, writable: false, revision: undefined }),
      subscribe: () => () => undefined,
      set: async () => true,
      unset: async () => true,
    }
    const locale = {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    }
    const slots = {
      inject: (_name: string, register: () => () => void) => register(),
      register: (definition: CapturedRegistration['definition'], component: unknown) => {
        captured = { definition, component }
        return () => { released = true }
      },
    }
    const configForms = {
      get: () => form,
      whileServed: (_namespaces: readonly string[], register: () => () => void) => register(),
    }
    const style = { dataset: {}, textContent: '', remove: () => undefined }
    vi.stubGlobal('document', {
      createElement: () => style,
      head: { appendChild: () => undefined },
    })
    const ctx = {
      get: (name: string) => {
        if (name === 'slots') return slots
        if (name === 'locale') return locale
        if (name === 'configForms') return configForms
        return undefined
      },
      effect: (callback: () => (() => void) | undefined) => {
        const dispose = callback()
        if (dispose !== undefined) cleanups.push(dispose)
      },
    }

    try {
      apply(ctx as unknown as Context)
      expect(captured?.definition.id).toBe('github-agents-proxy')
      expect(captured?.definition.label()).toBe('title')
      expect(captured?.definition.inject().form).toBe(form)
      for (const cleanup of cleanups.reverse()) cleanup()
      expect(released).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
