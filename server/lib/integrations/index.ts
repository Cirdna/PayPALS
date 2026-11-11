import type { Integrations } from '#shared/types'
import { searchProducts } from './channel3'
import { captureOrder, createCheckout } from './checkout'
import { notifyDeal } from './notify'

/**
 * THE interface other workstreams import:  import { integrations } from '~~/server/lib/integrations'
 * Owner: B. Files under server/lib/integrations MAY import from server/lib/ai (never the other way round).
 * telegram.ts reaches this file only through a dynamic import (the `pay:` button), so there is no static cycle.
 */
export const integrations: Integrations = { searchProducts, notifyDeal, createCheckout, captureOrder }
