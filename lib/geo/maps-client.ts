// Ticket 029: loads the Google Maps JavaScript API in the browser with the (public, referrer-restricted) browser
// key. Only client components import this; without a browser key nothing here is ever called. Minimal local
// types instead of @types/google.maps (no new dependency).

export type LatLngLiteral = { lat: number; lng: number };
type LatLng = { lat(): number; lng(): number };
type Listener = { remove(): void };

export interface GMap {
  fitBounds(bounds: GLatLngBounds, padding?: number): void;
  setCenter(c: LatLngLiteral): void;
  setZoom(z: number): void;
  getZoom(): number | undefined;
  addListener(event: string, handler: () => void): Listener;
}
export interface GLatLngBounds {
  extend(p: LatLngLiteral): GLatLngBounds;
}
export interface GAdvancedMarker {
  map: GMap | null;
  addListener(event: string, handler: () => void): Listener;
}
export interface GInfoWindow {
  setContent(content: Node | string): void;
  open(options: { map: GMap; anchor?: GAdvancedMarker }): void;
  close(): void;
}

export type MapsLibrary = {
  Map: new (el: HTMLElement, options: Record<string, unknown>) => GMap;
  InfoWindow: new (options?: Record<string, unknown>) => GInfoWindow;
  LatLngBounds: new () => GLatLngBounds;
};
export type MarkerLibrary = {
  AdvancedMarkerElement: new (options: { map: GMap; position: LatLngLiteral; title?: string; content?: Node; gmpClickable?: boolean }) => GAdvancedMarker;
};
export type PlacePrediction = {
  text: { toString(): string };
  toPlace(): { fetchFields(o: { fields: string[] }): Promise<unknown>; location?: LatLng | null; displayName?: string | null };
};
export type PlacesLibrary = {
  AutocompleteSessionToken: new () => object;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions(request: Record<string, unknown>): Promise<{ suggestions: { placePrediction: PlacePrediction | null }[] }>;
  };
};

type GoogleGlobal = { maps: { importLibrary(name: string): Promise<unknown> } };

declare global {
  interface Window {
    google?: GoogleGlobal;
    __dnmMapsReady?: () => void;
  }
}

let loading: Promise<GoogleGlobal> | null = null;

export function loadGoogleMaps(browserKey: string, language: string): Promise<GoogleGlobal> {
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google);
  if (loading) return loading;
  loading = new Promise<GoogleGlobal>((resolve, reject) => {
    window.__dnmMapsReady = () => (window.google ? resolve(window.google) : reject(new Error("Google Maps did not load")));
    const params = new URLSearchParams({
      key: browserKey,
      v: "weekly",
      loading: "async",
      callback: "__dnmMapsReady",
      region: "IN",
      language,
    });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Google Maps did not load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export async function importMaps(browserKey: string, language: string) {
  const google = await loadGoogleMaps(browserKey, language);
  const [maps, marker] = await Promise.all([google.maps.importLibrary("maps"), google.maps.importLibrary("marker")]);
  const core = (await google.maps.importLibrary("core")) as { LatLngBounds: MapsLibrary["LatLngBounds"] };
  return { maps: { ...(maps as Omit<MapsLibrary, "LatLngBounds">), LatLngBounds: core.LatLngBounds } as MapsLibrary, marker: marker as MarkerLibrary };
}

export async function importPlaces(browserKey: string, language: string): Promise<PlacesLibrary> {
  const google = await loadGoogleMaps(browserKey, language);
  return (await google.maps.importLibrary("places")) as PlacesLibrary;
}
