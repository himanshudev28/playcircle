"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { iceServers } from "@/lib/ice";

/* Voice/video calls as a WebRTC mesh: every caller holds one peer connection
   to every other caller, and Socket.IO carries the offers/answers/candidates.
   Fine for a handful of friends; past ~6 people you'd want an SFU.

   Each connection is created with an audio and a video transceiver up front,
   so turning the camera or mic on later is a replaceTrack() — no
   renegotiation, and no two peers ever offering at the same time.

   Every call seat has a server-issued session id, and signals are addressed
   session-to-session. A leave + quick rejoin therefore can't have a stale
   answer or candidate from the previous seat applied to the new connection. */

const AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const VIDEO: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24 },
  facingMode: "user",
};

// A connection that fails (usually NAT trouble) is rebuilt this many times.
const MAX_RETRIES = 2;

type Signal = {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
type Peer = { id: string; session: string };
type JoinReply = {
  ok: boolean;
  reason?: "blocked";
  session?: string;
  peers?: Peer[];
};

export type CallApi = ReturnType<typeof useCall>;

function stopAll(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function useCall(onNotice: (msg: string) => void) {
  const [inCall, setInCall] = useState(false);
  const [joining, setJoining] = useState(false);
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({});

  const inCallRef = useRef(false);
  const joiningRef = useRef(false);
  // Bumped by every teardown. Anything that awaited (getUserMedia, an SDP
  // step, the join ack) compares against it and bails if the call it
  // started in is gone.
  const genRef = useRef(0);
  const stateRef = useRef({ mic: false, cam: false });
  const micTrack = useRef<MediaStreamTrack | null>(null);
  const camTrack = useRef<MediaStreamTrack | null>(null);
  const busy = useRef({ audio: false, video: false });
  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const peerSession = useRef(new Map<string, string>());
  const initiated = useRef(new Set<string>());
  const retries = useRef(new Map<string, number>());
  const queued = useRef(new Map<string, RTCIceCandidateInit[]>());
  const callPeerRef = useRef<(p: Peer) => Promise<void>>(async () => {});
  const noticeRef = useRef(onNotice);
  useEffect(() => {
    noticeRef.current = onNotice;
  }, [onNotice]);

  const supported =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof RTCPeerConnection !== "undefined";

  const refreshLocal = useCallback(() => {
    const tracks = [micTrack.current, camTrack.current].filter(
      (t): t is MediaStreamTrack => !!t
    );
    setLocalStream(tracks.length ? new MediaStream(tracks) : null);
  }, []);

  const publish = useCallback((next: { mic: boolean; cam: boolean }) => {
    stateRef.current = next;
    setMic(next.mic);
    setCam(next.cam);
    getSocket().emit("call:state", next);
  }, []);

  const send = useCallback((to: string, data: Signal) => {
    getSocket().emit("call:signal", {
      to,
      toSession: peerSession.current.get(to),
      data,
    });
  }, []);

  // Point every connection's sender of `kind` at a (possibly null) track.
  const replaceAll = useCallback(
    (kind: "audio" | "video", track: MediaStreamTrack | null) => {
      for (const pc of pcs.current.values()) {
        for (const t of pc.getTransceivers()) {
          if (t.receiver.track.kind === kind) {
            t.sender.replaceTrack(track).catch(() => {});
          }
        }
      }
    },
    []
  );

  const attachLocal = useCallback((pc: RTCPeerConnection) => {
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      t.direction = "sendrecv";
      t.sender
        .replaceTrack(kind === "audio" ? micTrack.current : camTrack.current)
        .catch(() => {});
    }
  }, []);

  const removePeer = useCallback((id: string) => {
    pcs.current.get(id)?.close();
    pcs.current.delete(id);
    peerSession.current.delete(id);
    initiated.current.delete(id);
    retries.current.delete(id);
    queued.current.delete(id);
    setRemoteStreams((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const createPeer = useCallback(
    (id: string, session: string, asInitiator: boolean) => {
      pcs.current.get(id)?.close();
      queued.current.delete(id);
      peerSession.current.set(id, session);
      if (asInitiator) initiated.current.add(id);
      else initiated.current.delete(id);

      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      pc.onicecandidate = (e) => {
        if (e.candidate && pcs.current.get(id) === pc) {
          send(id, { candidate: e.candidate.toJSON() });
        }
      };
      pc.ontrack = () => {
        if (pcs.current.get(id) !== pc) return;
        // A fresh MediaStream each time so <video>/<audio> rebind cleanly.
        const stream = new MediaStream(pc.getReceivers().map((r) => r.track));
        setRemoteStreams((prev) => ({ ...prev, [id]: stream }));
      };
      pc.onconnectionstatechange = () => {
        if (pcs.current.get(id) !== pc) return;
        if (pc.connectionState === "connected") retries.current.delete(id);
        // The side that offered rebuilds the link; the other side just
        // accepts the new offer when it arrives.
        if (pc.connectionState === "failed" && initiated.current.has(id)) {
          const n = (retries.current.get(id) || 0) + 1;
          if (n > MAX_RETRIES) return;
          retries.current.set(id, n);
          callPeerRef.current({ id, session }).catch(() => {});
        }
      };
      pcs.current.set(id, pc);
      return pc;
    },
    [send]
  );

  const flushCandidates = useCallback(async (id: string) => {
    const pc = pcs.current.get(id);
    const list = queued.current.get(id);
    if (!pc || !list) return;
    queued.current.delete(id);
    for (const c of list) await pc.addIceCandidate(c).catch(() => {});
  }, []);

  // We're the newcomer: offer to everyone already in the call.
  const callPeer = useCallback(
    async ({ id, session }: Peer) => {
      const pc = createPeer(id, session, true);
      pc.addTransceiver("audio", { direction: "sendrecv" });
      pc.addTransceiver("video", { direction: "sendrecv" });
      attachLocal(pc);
      const offer = await pc.createOffer();
      if (pcs.current.get(id) !== pc) return;
      await pc.setLocalDescription(offer);
      if (pcs.current.get(id) !== pc) return;
      send(id, { sdp: pc.localDescription!.toJSON() });
    },
    [attachLocal, createPeer, send]
  );
  useEffect(() => {
    callPeerRef.current = callPeer;
  }, [callPeer]);

  const onSignal = useCallback(
    async ({
      from,
      fromSession,
      data,
    }: {
      from: string;
      fromSession: string;
      data: Signal;
    }) => {
      if (!inCallRef.current) return;
      try {
        if (data.sdp?.type === "offer") {
          const pc = createPeer(from, fromSession, false);
          await pc.setRemoteDescription(data.sdp);
          if (pcs.current.get(from) !== pc) return;
          attachLocal(pc);
          const answer = await pc.createAnswer();
          if (pcs.current.get(from) !== pc) return;
          await pc.setLocalDescription(answer);
          if (pcs.current.get(from) !== pc) return;
          send(from, { sdp: pc.localDescription!.toJSON() });
          await flushCandidates(from);
          return;
        }

        // Anything else must belong to the connection we currently have.
        if (peerSession.current.get(from) !== fromSession) return;
        const pc = pcs.current.get(from);
        if (!pc) return;

        if (data.sdp?.type === "answer") {
          if (pc.signalingState !== "have-local-offer") return;
          await pc.setRemoteDescription(data.sdp);
          await flushCandidates(from);
        } else if (data.candidate) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(data.candidate).catch(() => {});
          } else {
            const list = queued.current.get(from) || [];
            list.push(data.candidate);
            queued.current.set(from, list);
          }
        }
      } catch {
        /* a single bad peer shouldn't take the call down */
      }
    },
    [attachLocal, createPeer, flushCandidates, send]
  );

  // Local cleanup only — the server already knows (or is told separately).
  const teardown = useCallback(() => {
    genRef.current += 1;
    inCallRef.current = false;
    joiningRef.current = false;
    for (const id of [...pcs.current.keys()]) removePeer(id);
    peerSession.current.clear();
    initiated.current.clear();
    retries.current.clear();
    queued.current.clear();
    micTrack.current?.stop();
    camTrack.current?.stop();
    micTrack.current = null;
    camTrack.current = null;
    stateRef.current = { mic: false, cam: false };
    setInCall(false);
    setJoining(false);
    setMic(false);
    setCam(false);
    setLocalStream(null);
    setRemoteStreams({});
  }, [removePeer]);

  const join = useCallback(
    async (withVideo: boolean) => {
      if (inCallRef.current || joiningRef.current) return;
      if (!supported) {
        noticeRef.current("Calls need a secure connection (HTTPS or localhost)");
        return;
      }
      if (!getSocket().connected) {
        noticeRef.current("Reconnecting — try joining again in a moment");
        return;
      }
      joiningRef.current = true;
      setJoining(true);
      unlockAudio();
      const gen = genRef.current;

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: AUDIO,
          video: withVideo ? VIDEO : false,
        });
      } catch {
        // Camera busy/denied shouldn't stop you talking; no mic at all
        // still lets you listen in.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
          if (withVideo) {
            noticeRef.current("Camera unavailable — joined with voice only");
          }
        } catch {
          noticeRef.current("Microphone blocked — you can still listen in");
        }
      }

      // Removed, room ended, or left the page while the prompt was open.
      if (gen !== genRef.current || !getSocket().connected) {
        stopAll(stream);
        if (gen === genRef.current) teardown();
        return;
      }

      micTrack.current = stream?.getAudioTracks()[0] || null;
      camTrack.current = stream?.getVideoTracks()[0] || null;
      inCallRef.current = true;
      joiningRef.current = false;
      stateRef.current = { mic: !!micTrack.current, cam: !!camTrack.current };
      setMic(stateRef.current.mic);
      setCam(stateRef.current.cam);
      setInCall(true);
      setJoining(false);
      refreshLocal();

      getSocket().emit("call:join", stateRef.current, (res: JoinReply) => {
        if (gen !== genRef.current) return;
        if (!res?.ok) {
          teardown();
          noticeRef.current(
            res?.reason === "blocked"
              ? "The host turned off calls for you"
              : "Couldn't join the call — try again"
          );
          return;
        }
        for (const p of res.peers || []) {
          callPeer(p).catch(() => removePeer(p.id));
        }
      });
    },
    [callPeer, refreshLocal, removePeer, supported, teardown]
  );

  const leave = useCallback(() => {
    if (!inCallRef.current) return;
    getSocket().emit("call:leave");
    teardown();
  }, [teardown]);

  const toggleMic = useCallback(async () => {
    if (!inCallRef.current || busy.current.audio) return;
    const next = !stateRef.current.mic;
    if (next && !micTrack.current) {
      busy.current.audio = true;
      const gen = genRef.current;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      } catch {
        noticeRef.current("Microphone blocked — check your browser permissions");
        return;
      } finally {
        busy.current.audio = false;
      }
      if (gen !== genRef.current || !inCallRef.current) {
        stopAll(stream);
        return;
      }
      micTrack.current = stream.getAudioTracks()[0];
      replaceAll("audio", micTrack.current);
      refreshLocal();
    }
    if (micTrack.current) micTrack.current.enabled = next;
    publish({ ...stateRef.current, mic: next });
  }, [publish, refreshLocal, replaceAll]);

  const toggleCam = useCallback(async () => {
    if (!inCallRef.current || busy.current.video) return;
    if (stateRef.current.cam) {
      // Stop the track outright so the camera light goes off.
      camTrack.current?.stop();
      camTrack.current = null;
      replaceAll("video", null);
      refreshLocal();
      publish({ ...stateRef.current, cam: false });
      return;
    }
    busy.current.video = true;
    const gen = genRef.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
    } catch {
      noticeRef.current("Camera blocked or in use by another app");
      return;
    } finally {
      busy.current.video = false;
    }
    if (gen !== genRef.current || !inCallRef.current) {
      stopAll(stream);
      return;
    }
    camTrack.current?.stop();
    camTrack.current = stream.getVideoTracks()[0];
    replaceAll("video", camTrack.current);
    refreshLocal();
    publish({ ...stateRef.current, cam: true });
  }, [publish, refreshLocal, replaceAll]);

  // ---- Socket wiring ----
  useEffect(() => {
    const socket = getSocket();
    const onLeft = (id: string) => removePeer(id);
    const onForceMute = () => {
      if (!inCallRef.current || !stateRef.current.mic) return;
      if (micTrack.current) micTrack.current.enabled = false;
      publish({ ...stateRef.current, mic: false });
      noticeRef.current("The host muted your mic");
    };
    // The host revoked our call access; the server already dropped the seat.
    const onRevoked = () => {
      if (inCallRef.current || joiningRef.current) teardown();
    };
    // A dropped socket means the server already forgot our call seat.
    const onDisconnect = () => {
      if (inCallRef.current || joiningRef.current) {
        teardown();
        noticeRef.current("Connection lost — you left the call");
      }
    };

    socket.on("call:signal", onSignal);
    socket.on("call:left", onLeft);
    socket.on("call:force-mute", onForceMute);
    socket.on("call:revoked", onRevoked);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("call:signal", onSignal);
      socket.off("call:left", onLeft);
      socket.off("call:force-mute", onForceMute);
      socket.off("call:revoked", onRevoked);
      socket.off("disconnect", onDisconnect);
    };
  }, [onSignal, publish, removePeer, teardown]);

  // Leaving the page hangs up (and voids any getUserMedia still pending).
  useEffect(() => {
    return () => {
      if (inCallRef.current) getSocket().emit("call:leave");
      teardown();
    };
  }, [teardown]);

  return {
    supported,
    inCall,
    joining,
    mic,
    cam,
    localStream,
    remoteStreams,
    join,
    leave,
    teardown,
    toggleMic,
    toggleCam,
  };
}

/* ---------------------------------------------------- Speaking detection */

let audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

// Must run inside a user gesture (joining the call is one).
function unlockAudio() {
  getAudioCtx()?.resume().catch(() => {});
}

/** True while the stream's audio is above a speech-ish level. */
export function useSpeaking(stream: MediaStream | null, active = true) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    const ctx = getAudioCtx();
    if (!ctx || !stream || !active || stream.getAudioTracks().length === 0) {
      return;
    }
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let lastLoud = 0;
    let current = false;

    const id = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms > 0.035) lastLoud = now;
      // Hold the ring briefly so it doesn't flicker between syllables.
      const next = now - lastLoud < 350;
      if (next !== current) {
        current = next;
        setSpeaking(next);
      }
    }, 100);

    return () => {
      clearInterval(id);
      source.disconnect();
      setSpeaking(false);
    };
  }, [stream, active]);

  return active ? speaking : false;
}
