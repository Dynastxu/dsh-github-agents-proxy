import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

interface CapturedDefinition {
  readonly name: string
  readonly parameters: unknown
}

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'oneOf', 'description', 'title', 'default', 'examples',
])

/**
 * Report violations of the parameter-schema subset providers accept.
 *
 * Mirrors the rules the harness enforces for model-facing tool JSON: a single
 * type per node, `required` as a name array on object nodes only, and no
 * unknown keywords. A boolean `required` on a property is a top-level 400 from
 * the provider and blocks every request in the session, including compaction.
 */
function parameterViolations(node: unknown, path: string): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return [`${path} must be a schema object`]
  }
  const schema = node as Record<string, unknown>
  const violations: string[] = []
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) violations.push(`${path}.${key} is not a supported keyword`)
  }
  const type = schema['type']
  if (typeof type !== 'string' || !TYPES.has(type)) {
    violations.push(`${path}.type must be one of ${[...TYPES].join('/')}`)
    return violations
  }
  if (Object.hasOwn(schema, 'properties')) {
    if (type !== 'object') violations.push(`${path}.properties requires type "object"`)
    const properties = schema['properties']
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      violations.push(`${path}.properties must be an object of schemas`)
    } else {
      for (const [name, child] of Object.entries(properties)) {
        violations.push(...parameterViolations(child, `${path}.properties.${name}`))
      }
    }
  }
  if (Object.hasOwn(schema, 'required')) {
    if (type !== 'object') violations.push(`${path}.required is only supported on type "object"`)
    const required = schema['required']
    if (!Array.isArray(required) || required.some(name => typeof name !== 'string')) {
      violations.push(`${path}.required must be an array of property names`)
    }
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema['additionalProperties'] !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
  if (Object.hasOwn(schema, 'items')) {
    if (type !== 'array') violations.push(`${path}.items requires type "array"`)
    violations.push(...parameterViolations(schema['items'], `${path}.items`))
  }
  return violations
}

async function registeredTools(): Promise<Map<string, CapturedDefinition>> {
  const ctx = new Context()
  const tools = new Map<string, CapturedDefinition>()
  ctx.provide('tools', {
    register(definition: CapturedDefinition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  })
  ctx.provide('systemPrompt', {
    context: () => () => {},
    section: () => () => {},
  })
  try {
    await ctx.plugin(plugin)
    return new Map(tools)
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('tool parameter schemas', () => {
  it('detects the mismatch that broke a session: a boolean required on a string property', () => {
    const broken = {
      type: 'object',
      properties: { message: { type: 'string', required: true } },
    }
    expect(parameterViolations(broken, 'parameters')).toEqual([
      'parameters.properties.message.required is only supported on type "object"',
      'parameters.properties.message.required must be an array of property names',
    ])
  })

  it('declares object-rooted parameter schemas providers accept', async () => {
    for (const [name, definition] of await registeredTools()) {
      const parameters = definition.parameters as Record<string, unknown>
      expect(parameters['type'], name).toBe('object')
      expect(parameterViolations(parameters, 'parameters'), name).toEqual([])
    }
  })

  it('keeps commit message required at the object level', async () => {
    const commit = (await registeredTools()).get('commit_changes')
    expect(commit?.parameters).toMatchObject({ required: ['message'] })
  })
})
