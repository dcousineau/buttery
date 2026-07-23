export const RECIPE_COLLECTION = 'exchange.recipe.recipe'

/** exchange.recipe.recipe record, per https://recipe.exchange/lexicons */
export interface RecipeRecord {
  $type: typeof RECIPE_COLLECTION
  name: string
  text: string
  ingredients: Array<string>
  instructions: Array<string>
  prepTime?: string
  cookTime?: string
  totalTime?: string
  recipeYield?: string
  recipeCategory?: string
  recipeCuisine?: string
  cookingMethod?: string
  suitableForDiet?: Array<string>
  nutrition?: {
    calories?: number
    fatContent?: number
    proteinContent?: number
    carbohydrateContent?: number
  }
  langs?: Array<string>
  embed?: unknown
  attribution?: unknown
  createdAt: string
  updatedAt: string
}

export interface RecipeResult {
  uri: string
  cid?: string
  did: string
  rkey: string
  value: RecipeRecord
}

interface ParsedAtUri {
  authority: string
  collection: string
  rkey: string
}

/**
 * Accepts:
 *   at://did:plc:xxx/exchange.recipe.recipe/rkey
 *   at://handle.example.com/exchange.recipe.recipe/rkey
 *   handle.example.com/rkey  (collection implied)
 */
export function parseRecipeRef(input: string): ParsedAtUri {
  const trimmed = input.trim().replace(/^at:\/\//, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 3) {
    const [authority, collection, rkey] = parts
    return { authority, collection, rkey }
  }
  if (parts.length === 2) {
    const [authority, rkey] = parts
    return { authority, collection: RECIPE_COLLECTION, rkey }
  }
  throw new Error(
    'Expected an AT-URI like at://handle/exchange.recipe.recipe/rkey',
  )
}

async function xrpcGet<T>(base: string, nsid: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`/xrpc/${nsid}`, base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.message ?? `${nsid} failed (HTTP ${res.status})`)
  }
  return res.json() as Promise<T>
}

export async function resolveHandle(handle: string): Promise<string> {
  const data = await xrpcGet<{ did: string }>(
    'https://public.api.bsky.app',
    'com.atproto.identity.resolveHandle',
    { handle },
  )
  return data.did
}

/** Resolve a DID document and extract the PDS service endpoint. */
export async function resolvePds(did: string): Promise<string> {
  let docUrl: string
  if (did.startsWith('did:plc:')) {
    docUrl = `https://plc.directory/${did}`
  } else if (did.startsWith('did:web:')) {
    const host = did.slice('did:web:'.length).split(':').join('/')
    docUrl = `https://${decodeURIComponent(host)}/.well-known/did.json`
  } else {
    throw new Error(`Unsupported DID method: ${did}`)
  }
  const res = await fetch(docUrl)
  if (!res.ok) throw new Error(`Failed to resolve DID document for ${did}`)
  const doc = (await res.json()) as {
    service?: Array<{ id: string; type: string; serviceEndpoint: string }>
  }
  const pds = doc.service?.find(
    (s) => s.id.endsWith('#atproto_pds') || s.type === 'AtprotoPersonalDataServer',
  )
  if (!pds) throw new Error(`No PDS endpoint in DID document for ${did}`)
  return pds.serviceEndpoint
}

/**
 * Fetch a recipe record by reference. Public records — no auth required.
 * Resolution chain: handle → DID → DID doc → PDS → com.atproto.repo.getRecord.
 */
export async function fetchRecipe(ref: string): Promise<RecipeResult> {
  const { authority, collection, rkey } = parseRecipeRef(ref)
  const did = authority.startsWith('did:')
    ? authority
    : await resolveHandle(authority)
  const pds = await resolvePds(did)
  const data = await xrpcGet<{ uri: string; cid?: string; value: RecipeRecord }>(
    pds,
    'com.atproto.repo.getRecord',
    { repo: did, collection, rkey },
  )
  return { uri: data.uri, cid: data.cid, did, rkey, value: data.value }
}
