declare module "@xenova/transformers" {
  export function pipeline(
    task: "feature-extraction",
    model: string,
    options?: Record<string, unknown>
  ): Promise<{
    (text: string | string[], options?: { pooling?: "mean" | "cls"; normalize?: boolean }): Promise<{
      data: Float32Array
      dims: number[]
      type: string
    }>
  }>
}
