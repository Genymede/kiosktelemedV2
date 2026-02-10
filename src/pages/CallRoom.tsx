// src/pages/CallRoom.tsx
import { useEffect, useRef, useState } from 'react';
import { db } from '../firebase';
import { ref, set, onValue, onChildAdded, remove } from 'firebase/database';

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
      { urls: 'stun:stun2.l.google.com:19302' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
    iceTransportPolicy: 'all',
  };

  // Cleanup old signaling (safe)
  useEffect(() => {
    const base = `rooms/${roomId}`;
    console.log('[ROOM] init cleanup (safe):', roomId);

    remove(ref(db, `${base}/offer`));
    remove(ref(db, `${base}/answer`));
    remove(ref(db, `${base}/candidates`));
    // ไม่ลบ mobileReady

    offerSentRef.current = false;
  }, [roomId]);

  // 1. เปิดกล้อง
  useEffect(() => {
    const startCamera = async () => {
      try {
        console.log('[WEB][CAMERA] requesting media...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          console.log('[WEB][CAMERA] local preview ready');
        }
      } catch (err) {
        console.error('[WEB][CAMERA] error:', err);
        alert('ไม่สามารถเปิดกล้องหรือไมโครโฟนได้');
      }
    };

    startCamera();

    return () => {
      console.log('[WEB][CAMERA] cleanup local stream');
      localStream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // 2. สร้าง PC
  useEffect(() => {
    if (!localStream) return;

    console.log('[WEBRTC][WEB] create peerconnection');
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
      console.log('[WEBRTC][WEB] addTrack:', track.kind);
    });

    pc.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      console.log('[WEBRTC][WEB] ontrack remote stream received');

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          event.candidate.toJSON()
        );
      }
    };

    // Debug เพิ่ม
    pc.oniceconnectionstatechange = () => {
      console.log('[ICE] iceConnectionState:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.warn('[ICE] FAILED → restartIce');
        pc.restartIce();
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[PC] connectionState:', pc.connectionState);
    };

    pc.onicegatheringstatechange = () => {
      console.log('[ICE] gatheringState:', pc.iceGatheringState);
    };

    pc.onicecandidateerror = (e) => {
      console.error('[ICE ERROR]', e.errorCode, e.errorText, e.url);
    };

    return () => {
      console.log('[WEBRTC][WEB] cleanup pc');
      pc.close();
      pcRef.current = null;
    };
  }, [localStream, roomId]);

  // 3-5. Signaling เหมือนเดิม (mobileReady → offer, answer, ICE mobile)

  useEffect(() => {
    const readyRef = ref(db, `rooms/${roomId}/mobileReady`);

    const unsubscribe = onValue(readyRef, async (snap) => {
      const ready = snap.val() === true;
      const pc = pcRef.current;

      if (!ready || !pc) return;
      if (offerSentRef.current) return;
      if (pc.signalingState !== 'stable') return;

      try {
        console.log('[SIGNAL][WEB] mobileReady=true -> createOffer');

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await set(ref(db, `rooms/${roomId}/offer`), {
          type: offer.type,
          sdp: offer.sdp,
        });

        offerSentRef.current = true;
        console.log('[SIGNAL][WEB] offer saved');
      } catch (err) {
        console.error('[SIGNAL][WEB] createOffer error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  useEffect(() => {
    const answerRef = ref(db, `rooms/${roomId}/answer`);

    const unsubscribe = onValue(answerRef, async (snap) => {
      const pc = pcRef.current;
      const data = snap.val();

      if (!pc || !data) return;
      if (pc.currentRemoteDescription) return;

      try {
        console.log('[SIGNAL][WEB] got answer -> setRemoteDescription');
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } catch (err) {
        console.error('[SIGNAL][WEB] setRemoteDescription(answer) error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  useEffect(() => {
    const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);

    const unsubscribe = onChildAdded(iceRef, async (snap) => {
      const pc = pcRef.current;
      if (!pc) return;

      const cand = snap.val();
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
        console.log('[ICE] added mobile candidate');
      } catch (err) {
        console.error('[ICE][WEB] addIceCandidate error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  // 6. Leave (เหมือนเดิม ดีมาก)
  const handleLeave = async () => {
    try {
      console.log('[WEB] leaving room');

      if (pcRef.current) {
        pcRef.current.getSenders().forEach(sender => {
          if (sender.track) {
            sender.track.stop();
            pcRef.current?.removeTrack(sender);
          }
        });

        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.close();
        pcRef.current = null;
      }

      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
      }

      if (localVideoRef.current) {
        localVideoRef.current.pause();
        localVideoRef.current.srcObject = null;
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.pause();
        remoteVideoRef.current.srcObject = null;
      }

      await remove(ref(db, `rooms/${roomId}/offer`));
      await remove(ref(db, `rooms/${roomId}/answer`));
      await remove(ref(db, `rooms/${roomId}/candidates`));
      await remove(ref(db, `rooms/${roomId}/mobileReady`));

      console.log('[WEB] cleanup done – camera should be OFF');
    } catch (e) {
      console.warn('[WEB] leave cleanup err', e);
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