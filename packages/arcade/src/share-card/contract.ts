/**
 * What the seller's card and the Worker's proxy agree on without either importing the renderer: the card's size, which the
 * Worker checks in the PNG header, and the revision that keys every cached copy.
 */
/** Bump whenever the layer art or the composition changes, so cached cards are redrawn. */
export const CARD_REVISION = 3;
export const CARD_WIDTH = 1200, CARD_HEIGHT = 630;
