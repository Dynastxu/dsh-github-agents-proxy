import { describe, expect, it, vi } from 'vitest'
import { hostPathBridge } from '../src/client/file-picker.ts'

describe('Desktop file-path bridge', () => {
  it('rejects values that are not the Desktop bridge', () => {
    expect(hostPathBridge(undefined)).toBeUndefined()
    expect(hostPathBridge(null)).toBeUndefined()
    expect(hostPathBridge('bridge')).toBeUndefined()
    expect(hostPathBridge({})).toBeUndefined()
    expect(hostPathBridge({ pathFor: 'nope' })).toBeUndefined()
  })

  it('resolves a chosen file through the bridge', () => {
    const pathFor = vi.fn((file: File) => `C:\\keys\\${file.name}`)
    const bridge = hostPathBridge({ pathFor })
    const file = new File(['pem'], 'app.pem')
    expect(bridge?.pathFor(file)).toBe('C:\\keys\\app.pem')
    expect(pathFor).toHaveBeenCalledWith(file)
  })

  it('keeps the bridge receiver when calling pathFor', () => {
    const bridge = hostPathBridge({
      prefix: 'C:\\keys\\',
      pathFor(this: { prefix: string }, file: File) { return `${this.prefix}${file.name}` },
    })
    expect(bridge?.pathFor(new File(['pem'], 'app.pem'))).toBe('C:\\keys\\app.pem')
  })

  it('returns an empty path when the bridge answers with a non-string', () => {
    const bridge = hostPathBridge({ pathFor: () => 42 })
    expect(bridge?.pathFor(new File(['pem'], 'app.pem'))).toBe('')
  })
})
