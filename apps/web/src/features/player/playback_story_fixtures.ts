import type { PlaybackState } from "@/shared/types";

export function mock_playback_requests() {
  const original_fetch = window.fetch;
  let playback: PlaybackState = {
    library_id: "library-019c0000000070008000000000000001",
    position_seconds: 0,
    playback_rate: 1,
    last_watched_at: null,
  };
  window.fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const pathname = new URL(target, window.location.href).pathname;
    if (
      pathname.startsWith("/api/media/assets/") &&
      pathname.endsWith("/playback")
    ) {
      if (init?.method === "PATCH" && typeof init.body === "string") {
        playback = { ...playback, ...JSON.parse(init.body) };
      }
      return Response.json(playback);
    }
    return original_fetch(input, init);
  };
  return () => {
    window.fetch = original_fetch;
  };
}
