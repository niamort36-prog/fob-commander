/** Couches affichées sur la carte tactique (partagées entre la scène et le panneau de légende). */
export const mapLayers = {
  contacts: true,
  uncertainty: true,
  friendly: true,
  villages: true,
  personalities: true,
  coverage: true,
  sites: true,
  world: true,
};

export type MapLayer = keyof typeof mapLayers;
