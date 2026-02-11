// src/pages/CallRoom.tsx
import { useEffect, useRef, useState } from 'react';
import { db } from '../firebase';
import {
  ref,
  set,
  onValue,
  onChildAdded,
  remove,
} from 'firebase/database';

type CallRoomProps = {
  roomId: string;
  doctorName: string;
  onLeave: () => void;
};

export default function CallRoom({ roomId, doctorName, onLeave }: CallRoomProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMobileReady, setIsMobileReady] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const offerSentRef = useRef(false);

  const pcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // // แนะนำให้เพิ่ม TURN ตัวนี้จริง ๆ เพื่อแก้ปัญหา NAT/Firewall
      // {
      //   urls: [
      //     'turn:openrelay.metered.ca:80',
      //     'turn:openrelay.metered.ca:443?transport=tcp',
      //   ],
      //   username: 'openrelayproject',
      //   credential: 'openrelayproject',
      // },
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turn:asia.relay.metered.ca:80",
        username: "59d5900a25092f3c11694ed7",
        credential: "8bGdNoy1Spp7xyqI",
      },
      {
        urls: "turn:asia.relay.metered.ca:80?transport=tcp",
        username: "59d5900a25092f3c11694ed7",
        credential: "8bGdNoy1Spp7xyqI",
      },
      {
        urls: "turn:asia.relay.metered.ca:443",
        username: "59d5900a25092f3c11694ed7",
        credential: "8bGdNoy1Spp7xyqI",
      },
      {
        urls: "turns:asia.relay.metered.ca:443?transport=tcp",
        username: "59d5900a25092f3c11694ed7",
        credential: "8bGdNoy1Spp7xyqI",
      },
    ],
    iceTransportPolicy: 'all',
  };

  // 0. Cleanup ข้อมูลเก่าในห้อง (safe mode)
  useEffect(() => {
    console.log(`[INIT] Starting safe cleanup for room: ${roomId}`);
    const base = `rooms/${roomId}`;

    remove(ref(db, `${base}/offer`)).catch(e => console.warn('[CLEANUP] offer failed', e));
    remove(ref(db, `${base}/answer`)).catch(e => console.warn('[CLEANUP] answer failed', e));
    remove(ref(db, `${base}/candidates`)).catch(e => console.warn('[CLEANUP] candidates failed', e));
    // ไม่ลบ mobileReady

    offerSentRef.current = false;
    console.log('[INIT] Cleanup completed');
  }, [roomId]);

  // 1. เปิดกล้อง + ไมค์
  useEffect(() => {
    console.log('[CAMERA] Requesting getUserMedia...');
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        console.log('[CAMERA] getUserMedia success → tracks:', stream.getTracks().map(t => t.kind));

        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          console.log('[CAMERA] Local preview assigned');
        }
      } catch (err) {
        console.error('[CAMERA] getUserMedia error:', err);
        alert('ไม่สามารถเปิดกล้องหรือไมโครโฟนได้');
      }
    };

    startCamera();

    return () => {
      console.log('[CAMERA] Stopping local tracks...');
      localStream?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // 2. สร้าง PeerConnection เมื่อมี localStream
  useEffect(() => {
    if (!localStream) return;

    console.log('[PC] Creating RTCPeerConnection');
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    localStream.getTracks().forEach(track => {
      console.log(`[PC] Adding ${track.kind} track`);
      pc.addTrack(track, localStream);
    });

    pc.ontrack = (event) => {
      console.log('[PC] ontrack → received remote stream');
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[ICE] New local candidate → type:', event.candidate.type);
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          event.candidate.toJSON()
        );
      } else {
        console.log('[ICE] Gathering completed (last candidate)');
      }
    };

    pc.onicegatheringstatechange = () => {
      console.log('[ICE] gatheringState →', pc.iceGatheringState);
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[ICE] iceConnectionState →', pc.iceConnectionState);
    };

    pc.onsignalingstatechange = () => {
      console.log('[SIGNALING] signalingState →', pc.signalingState);
    };

    pc.onconnectionstatechange = () => {
      console.log('[PC] connectionState →', pc.connectionState);
    };

    return () => {
      console.log('[PC] Closing PeerConnection');
      pc.close();
      pcRef.current = null;
    };
  }, [localStream, roomId]);

  // 3. ฟัง mobileReady (แค่ set state)
  useEffect(() => {
    const readyRef = ref(db, `rooms/${roomId}/mobileReady`);
    console.log('[SIGNAL] Listening mobileReady');

    const unsubscribe = onValue(readyRef, (snap) => {
      const ready = snap.val() === true;
      console.log('[SIGNAL] mobileReady →', ready);
      setIsMobileReady(ready);
    });

    return () => {
      console.log('[SIGNAL] Unsub mobileReady');
      unsubscribe();
    };
  }, [roomId]);

  // 4. สร้าง offer เมื่อทั้ง mobileReady + localStream พร้อม
  useEffect(() => {
    if (!isMobileReady) return;
    if (!localStream) return;

    const pc = pcRef.current;
    if (!pc) return;
    if (offerSentRef.current) return;
    if (pc.signalingState !== 'stable') {
      console.log('[OFFER] Skip - signaling not stable:', pc.signalingState);
      return;
    }

    console.log('[OFFER] READY → Creating offer');

    const createOffer = async () => {
      try {
        const offer = await pc.createOffer();
        console.log('[OFFER] createOffer done');

        await pc.setLocalDescription(offer);
        console.log('[OFFER] setLocalDescription done');

        await set(ref(db, `rooms/${roomId}/offer`), {
          type: offer.type,
          sdp: offer.sdp,
        });
        console.log('[OFFER] Offer saved to Firebase');

        offerSentRef.current = true;
      } catch (err) {
        console.error('[OFFER] createOffer failed:', err);
      }
    };

    createOffer();
  }, [isMobileReady, localStream, roomId]);

  // 5. ฟัง answer
  useEffect(() => {
    const answerRef = ref(db, `rooms/${roomId}/answer`);

    const unsubscribe = onValue(answerRef, async (snap) => {
      const data = snap.val();
      if (!data) return;

      const pc = pcRef.current;
      if (!pc || pc.currentRemoteDescription) return;

      console.log('[SIGNAL] Received answer → setting remote desc');
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        console.log('[SIGNAL] setRemoteDescription success');
      } catch (err) {
        console.error('[SIGNAL] setRemoteDescription error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  // 6. รับ ICE candidates จาก mobile
  useEffect(() => {
    const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);

    const unsubscribe = onChildAdded(iceRef, async (snap) => {
      const cand = snap.val();
      const pc = pcRef.current;
      if (!pc || !cand) return;

      console.log('[ICE] Adding remote candidate from mobile');
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
        console.log('[ICE] addIceCandidate success');
      } catch (err) {
        console.error('[ICE] addIceCandidate error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  // 7. วางสาย
  const handleLeave = async () => {
    console.log('[LEAVE] Starting leave...');

    if (pcRef.current) {
      pcRef.current.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
          pcRef.current?.removeTrack(sender);
        }
      });
      pcRef.current.close();
      pcRef.current = null;
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }

    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    const base = `rooms/${roomId}`;
    await remove(ref(db, `${base}/offer`)).catch(() => { });
    await remove(ref(db, `${base}/answer`)).catch(() => { });
    await remove(ref(db, `${base}/candidates`)).catch(() => { });
    // ไม่ลบ mobileReady เพื่อให้หมอ set ใหม่ได้

    console.log('[LEAVE] Cleanup done');
    onLeave();
  };

  return (
    <div className="min-h-screen bg-black flex flex-col">
      <div className="p-4 bg-gray-900 text-white flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold">ห้องสนทนา</h1>
          <p className="text-sm text-gray-300">
            Room: <span className="font-mono">{roomId}</span>
          </p>
        </div>
        <button
          onClick={handleLeave}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-semibold"
        >
          วางสาย
        </button>
      </div>

      <div className="flex-1 relative bg-black">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-fit-cover"
        />
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-6 right-6 w-40 h-56 rounded-xl object-cover border-2 border-gray-800"
        />
      </div>

      <div className="p-4 bg-gray-900 text-gray-300 text-center">
        กำลังสนทนากับแพทย์: <span className="font-semibold">{doctorName}</span>
      </div>
    </div>
  );
}