import { NamedError } from "@opencode-ai/util/error"
import { z } from "zod/v4"

export const KiroAuthError = NamedError.create("KiroAuthError", z.object({ message: z.string() }))

export const KiroApiError = NamedError.create("KiroApiError", z.object({ status: z.number(), body: z.string() }))

export const KiroStreamError = NamedError.create("KiroStreamError", z.object({ message: z.string() }))
