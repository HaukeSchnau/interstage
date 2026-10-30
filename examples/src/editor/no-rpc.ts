// Stands in for vscode-jsonrpc's Node transport in the browser build. ts-content-mapper has one
// entry, which holds both MappedCodeBuilder, the part interstage's compiler uses, and the
// stdin/stdout runner that imports this transport. A builder-only export in ts-content-mapper
// would let this file go.
export const ErrorCodes = {}
export class RequestType {}
export class ResponseError extends Error {}
export function createMessageConnection(): never {
  throw new Error('Content mappers run under tsc, not in a browser.')
}
