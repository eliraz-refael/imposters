declare const Bun: {
  serve(options: {
    readonly port: number
    readonly fetch: (request: Request) => Promise<Response>
  }): { readonly port: number; stop(closeActive: boolean): void }
}
