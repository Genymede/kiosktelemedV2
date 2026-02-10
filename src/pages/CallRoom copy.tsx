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
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const offerSentRef = useRef(false);

  const pcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // 0) Cleanup เก่า
  useEffect(() => {
    console.log(`[INIT] Starting safe cleanup for room: ${roomId}`);
    const base = `rooms/${roomId}`;

    remove(ref(db, `${base}/offer`)).catch(e => console.warn('[CLEANUP] offer remove failed', e));
    remove(ref(db, `${base}/answer`)).catch(e => console.warn('[CLEANUP] answer remove failed', e));
    remove(ref(db, `${base}/candidates`)).catch(e => console.warn('[CLEANUP] candidates remove failed', e));

    offerSentRef.current = false;
    console.log('[INIT] Cleanup completed, offerSentRef reset');
  }, [roomId]);

  // 1) เปิดกล้อง + ไมค์
  useEffect(() => {
    console.log('[CAMERA] Starting getUserMedia request');
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        console.log('[CAMERA] getUserMedia SUCCESS - tracks:', stream.getTracks().map(t => t.kind));

        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          console.log('[CAMERA] Local video element assigned srcObject');
        }
      } catch (err) {
        console.error('[CAMERA] getUserMedia FAILED:', err);
        alert('ไม่สามารถเปิดกล้องหรือไมโครโฟนได้');
      }
    };

    startCamera();

    return () => {
      console.log('[CAMERA] Cleanup - stopping local tracks');
      localStream?.getTracks().forEach(t => {
        console.log(`[CAMERA] Stopping track: ${t.kind} (${t.id})`);
        t.stop();
      });
    };
  }, []);

  // 2) สร้าง PeerConnection
  useEffect(() => {
    if (!localStream) {
      console.log('[PC] Waiting for localStream...');
      return;
    }

    console.log('[PC] Creating new RTCPeerConnection');
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;
    console.log('[PC] PeerConnection created');

    // Add tracks
    localStream.getTracks().forEach(track => {
      console.log(`[PC] Adding track: ${track.kind} (id: ${track.id})`);
      pc.addTrack(track, localStream);
    });

    // Events
    pc.ontrack = event => {
      console.log('[PC] ontrack - received remote stream', event.streams?.[0]?.id);
      if (remoteVideoRef.current && event.streams?.[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
        console.log('[PC] Remote video assigned srcObject');
      }
    };

    pc.onicecandidate = event => {
      if (event.candidate) {
        console.log('[ICE] New local ICE candidate generated:', {
          type: event.candidate.type,
          address: event.candidate.address,
          port: event.candidate.port,
          protocol: event.candidate.protocol,
        });
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          event.candidate.toJSON()
        ).then(() => console.log('[ICE] Local candidate saved to Firebase'));
      } else {
        console.log('[ICE] ICE gathering completed (null candidate)');
      }
    };

    pc.onicecandidateerror = e => {
      console.error('[ICE ERROR] ICE candidate error:', {
        code: e.errorCode,
        text: e.errorText,
        url: e.url,
      });
    };

    pc.onicegatheringstatechange = () => {
      console.log('[ICE] gatheringState changed →', pc.iceGatheringState);
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[ICE] iceConnectionState changed →', pc.iceConnectionState);
    };

    pc.onsignalingstatechange = () => {
      console.log('[SIGNALING] signalingState changed →', pc.signalingState);
    };

    pc.onconnectionstatechange = () => {
      console.log('[PC] connectionState changed →', pc.connectionState);
    };

    return () => {
      console.log('[PC] Cleanup - closing PeerConnection');
      pc.close();
      pcRef.current = null;
    };
  }, [localStream, roomId]);

  // 3) รอ mobileReady → create offer
  useEffect(() => {
    console.log('[SIGNAL] Starting listener for mobileReady');
    const readyRef = ref(db, `rooms/${roomId}/mobileReady`);

    const unsubscribe = onValue(readyRef, async snap => {
      const ready = snap.val() === true;
      console.log('[SIGNAL] mobileReady changed →', ready);

      const pc = pcRef.current;
      if (!ready) return;
      if (!pc) {
        console.warn('[SIGNAL] mobileReady true but pc is null → waiting');
        return;
      }
      if (offerSentRef.current) {
        console.log('[SIGNAL] Offer already sent, skipping');
        return;
      }
      if (pc.signalingState !== 'stable') {
        console.warn('[SIGNAL] signalingState not stable →', pc.signalingState);
        return;
      }

      console.log('[SIGNAL] All conditions met → creating offer');
      try {
        const offer = await pc.createOffer();
        console.log('[SIGNAL] createOffer success');

        await pc.setLocalDescription(offer);
        console.log('[SIGNAL] setLocalDescription success');

        await set(ref(db, `rooms/${roomId}/offer`), {
          type: offer.type,
          sdp: offer.sdp,
        });
        console.log('[SIGNAL] Offer saved to Firebase');

        offerSentRef.current = true;
      } catch (err) {
        console.error('[SIGNAL] createOffer / setLocalDescription failed:', err);
      }
    });

    return () => {
      console.log('[SIGNAL] Unsubscribing mobileReady listener');
      unsubscribe();
    };
  }, [roomId]);

  // 4) ฟัง answer
  useEffect(() => {
    console.log('[SIGNAL] Starting listener for answer');
    const answerRef = ref(db, `rooms/${roomId}/answer`);

    const unsubscribe = onValue(answerRef, async snap => {
      const data = snap.val();
      if (!data) return;

      const pc = pcRef.current;
      if (!pc) return;
      if (pc.currentRemoteDescription) {
        console.log('[SIGNAL] Already have remote description, skipping answer');
        return;
      }

      console.log('[SIGNAL] Received answer → setting remote description');
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        console.log('[SIGNAL] setRemoteDescription success');
      } catch (err) {
        console.error('[SIGNAL] setRemoteDescription failed:', err);
      }
    });

    return () => {
      console.log('[SIGNAL] Unsubscribing answer listener');
      unsubscribe();
    };
  }, [roomId]);

  // 5) รับ ICE จาก mobile
  useEffect(() => {
    console.log('[ICE] Starting listener for mobile candidates');
    const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);

    const unsubscribe = onChildAdded(iceRef, async snap => {
      const cand = snap.val();
      const pc = pcRef.current;
      if (!pc || !cand) return;

      console.log('[ICE] Received remote ICE candidate from mobile');
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
        console.log('[ICE] addIceCandidate success');
      } catch (err) {
        console.error('[ICE] addIceCandidate failed:', err);
      }
    });

    return () => {
      console.log('[ICE] Unsubscribing mobile ICE listener');
      unsubscribe();
    };
  }, [roomId]);

  // 6) Leave
  const handleLeave = async () => {
    console.log('[LEAVE] Starting leave process');
    try {
      if (pcRef.current) {
        console.log('[LEAVE] Removing tracks and closing PC');
        pcRef.current.getSenders().forEach(sender => {
          if (sender.track) {
            console.log(`[LEAVE] Stopping sender track: ${sender.track.kind}`);
            sender.track.stop();
            pcRef.current?.removeTrack(sender);
          }
        });
        pcRef.current.close();
        pcRef.current = null;
      }

      if (localStream) {
        console.log('[LEAVE] Stopping local stream tracks');
        localStream.getTracks().forEach(t => t.stop());
        setLocalStream(null);
      }

      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

      console.log('[LEAVE] Clearing Firebase signaling data');
      const base = `rooms/${roomId}`;
      await remove(ref(db, `${base}/offer`));
      await remove(ref(db, `${base}/answer`));
      await remove(ref(db, `${base}/candidates`));
      await remove(ref(db, `${base}/mobileReady`));

      console.log('[LEAVE] Cleanup completed');
    } catch (e) {
      console.error('[LEAVE] Error during cleanup:', e);
    }

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