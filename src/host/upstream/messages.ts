/**
 * messages — 自 src/host/upstream.ts 原文搬迁，未改逻辑
 *
 * 拆分依据 docs/issues/22-upstream-split.md；本文件代码逐字来自拆分前的
 * upstream.ts（见 git 历史里拆分前的那一版），只做 import/export 整理与
 * 文件头标注。协议事实的原文注释在 crypto.ts 头部。
 */

/**
 * One chat turn, streamed.
 *
 * Yields plain objects in the OpenAI chunk vocabulary
 * (`{ choices: [{ delta, finish_reason }] }`) so the caller can forward them
 * without knowing about Qoder's envelope.
 *
 * @param region - the region descriptor.
 * @param credential - `{ userID, token, name, email, machineID }`.
 * @param request - `{ model, messages, tools, maxTokens, enableThinking, alwaysThinking, reasoningEffort, sessionId }`.
 *   `alwaysThinking` marks a model that rejects `enable_thinking: false`; for
 *   those the flag is omitted entirely rather than sent as `false`.
 * @yields OpenAI-shaped chat completion chunks.
 */
/** One message as Qoder's chat route wants it. */
export interface QoderMessage {
  role?: string
  content?: unknown
  [field: string]: unknown
}

/**
 * Normalize a message list into what the Qoder endpoint accepts.
 *
 * Two vocabularies can arrive here and both must survive the trip:
 *
 * - **OpenAI shape**, which is what pi-ai actually sends through the shim:
 *   `tool_calls` on the assistant message and `role: "tool"` with a
 *   `tool_call_id` for the result. Dropping either would break the harness's
 *   tool loop on the second turn, which is the single most important thing
 *   this translation has to get right.
 * - **DSH shape** (`toolCall` content blocks, `toolResult` role), accepted so
 *   the function stays usable from a direct caller.
 *
 * Image parts become `image_url` parts carrying a data URL, which is the only
 * image form this endpoint accepts.
 *
 * @param messages - messages in either vocabulary.
 * @returns Qoder-shaped messages.
 */
export function toQoderMessages(messages: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const raw of messages as Array<Record<string, unknown>>) {
    const message = raw
    if (message === null || typeof message !== 'object') continue

    if (message.role === 'system' || message.role === 'developer') {
      // `developer` is OpenAI's newer name for the same thing, and pi-ai emits
      // it whenever a reasoning model's compat allows it. Qoder only knows
      // `system`, so the two collapse into one here. Dropping the role instead
      // (which is what an unhandled value used to do) left the request with no
      // system message at all, and the gateway answers that with a permanent
      // `403 {"code":"10605"}` on every retry.
      out.push({ role: 'system', content: textOf(message.content) })
      continue
    }

    if (message.role === 'user') {
      const parts = []
      let hasImage = false
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'text') parts.push({ type: 'text', text: block.text ?? '' })
          else if (block?.type === 'image_url' || block?.type === 'image') {
            // Two shapes reach this function and BOTH must survive:
            //
            // - `image_url` is what pi-ai's OpenAI-completions API actually puts
            //   on the wire through the shim (it maps every image block to
            //   `{ type: 'image_url', image_url: { url } }`), so this is the
            //   shape the harness really sends. Matching only `image` here made
            //   every attached image silently disappear on the way out.
            // - `image` with bytes is the DSH-native shape, kept so the function
            //   stays usable from a direct caller.
            const url = block.image_url?.url ?? (typeof block.data === 'string'
              ? `data:${block.mimeType ?? 'image/png'};base64,${block.data}`
              : undefined)
            if (url !== undefined) {
              hasImage = true
              parts.push({ type: 'image_url', image_url: { url } })
            }
          }
        }
      }
      out.push({ role: 'user', content: hasImage ? parts : textOf(message.content) })
      continue
    }

    if (message.role === 'assistant') {
      let text = ''
      const toolCalls = []

      // OpenAI shape: tool_calls sit on the message itself.
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (call == null || typeof call !== 'object') continue
          const id = call.id
          if (typeof id !== 'string' || id.length === 0) {
            throw new Error('toQoderMessages: assistant tool_call is missing an id; the tool loop cannot match the result back to it')
          }
          const name = call.function?.name ?? call.name
          if (typeof name !== 'string' || name.length === 0) {
            throw new Error(`toQoderMessages: assistant tool_call "${id}" has no function name; the gateway cannot dispatch it`)
          }
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              arguments:
                typeof call.function?.arguments === 'string'
                  ? call.function.arguments
                  : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}),
            },
          })
        }
      }

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'text') text += block.text ?? ''
          // DSH shape: tool calls are content blocks.
          else if (block?.type === 'toolCall') {
            const id = block.id
            if (typeof id !== 'string' || id.length === 0) {
              throw new Error('toQoderMessages: assistant toolCall block is missing an id; the tool loop cannot match the result back to it')
            }
            if (typeof block.name !== 'string' || block.name.length === 0) {
              throw new Error(`toQoderMessages: toolCall "${id}" has no function name; the gateway cannot dispatch it`)
            }
            toolCalls.push({
              id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
            })
          }
        }
      } else {
        text = textOf(message.content)
      }

      // An assistant turn that only called tools carries no content; the
      // endpoint rejects a null content field, so an empty string is sent.
      // Typed as the element of `out` rather than `any`: `content` is a string
      // and `tool_calls` is a real array, so both assignments are checked.
      const entry: Record<string, unknown> = { role: 'assistant', content: text }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      out.push(entry)
      continue
    }

    if (message.role === 'toolResult' || message.role === 'tool') {
      const toolCallId = message.toolCallId ?? message.tool_call_id
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        throw new Error('toQoderMessages: tool result message is missing tool_call_id; it cannot be linked to the calling assistant turn')
      }
      out.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: textOf(message.content),
      })
    }
  }
  return out
}

/** Flatten a DSH content value into plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === 'text') text += typeof block.text === 'string' ? block.text : ''
  }
  return text
}

/**
 * Normalize tool definitions into the endpoint's function schema.
 *
 * pi-ai hands the shim tools that are already OpenAI-shaped
 * (`{ type: "function", function: { name, description, parameters } }`), so the
 * common case is a pass-through. A bare DSH descriptor (`{ name, description,
 * parameters }`) is also accepted and wrapped, which keeps this usable from a
 * direct caller as well.
 *
 * @param tools - tool descriptors in either shape.
 * @returns OpenAI-shaped tool entries.
 */
export function toQoderTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return []
  // One tool, in either of the two vocabularies described above. Declared
  // loosely on purpose: the branches below narrow it field by field, and a
  // closed shape here would just be a claim about pi-ai's internals — see the
  // note on peer types in `domain.ts`.
  type ToolDescriptor = {
    function?: { name?: unknown; description?: unknown; parameters?: unknown }
    name?: unknown
    description?: unknown
    parameters?: unknown
  }
  return (tools as ToolDescriptor[]).map((tool, index) => {
    if (tool?.function != null && typeof tool.function === 'object') {
      const name = tool.function.name
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`toQoderTools: tool at index ${index} has no function name; the gateway cannot register it`)
      }
      return {
        type: 'function',
        function: {
          name,
          description: tool.function.description ?? '',
          parameters: tool.function.parameters ?? { type: 'object', properties: {} },
        },
      }
    }
    const name = tool?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`toQoderTools: tool at index ${index} has no name; the gateway cannot register it`)
    }
    return {
      type: 'function',
      function: {
        name,
        description: tool?.description ?? '',
        parameters: tool?.parameters ?? { type: 'object', properties: {} },
      },
    }
  })
}
