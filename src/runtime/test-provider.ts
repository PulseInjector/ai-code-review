export function resultToolResponse(name: string, argumentsText: string): Response {
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
    id: "test-submission", object: "chat.completion.chunk", created: 0, model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  return new Response(chunk({ tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: {
    name, arguments: argumentsText,
  } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}
