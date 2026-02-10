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
  const [isMobileReady, setIsMobileReady] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const offerSentRef = useRef(false);

  const pcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  };

  // 0) Cleanup ค่าเก่าใน Firebase
  useEffect(() => {
    const base = `rooms/${roomId}`;
    console.log('[ROOM] init cleanup (safe):', roomId);

    remove(ref(db, `${base}/offer`));
    remove(ref(db, `${base}/answer`));
    remove(ref(db, `${base}/candidates`));

    offerSentRef.current = false;
    setIsMobileReady(false);
  }, [roomId]);

  // 1) เปิดกล้อง + ✅ เพิ่ม Cleanup ที่ถูกต้อง
  useEffect(() => {
    let myStream: MediaStream | null = null; // ตัวแปร local เพื่อให้ cleanup เข้าถึงได้แน่นอน

    const startCamera = async () => {
      try {
        console.log('[WEB][CAMERA] requesting media...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        myStream = stream; // เก็บค่าไว้ในตัวแปร local
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

    // ✅✅✅ ส่วนสำคัญที่เพิ่มมา: บังคับปิดกล้องเมื่อ Component ถูกทำลาย ✅✅✅
    return () => {
      console.log('[WEB][CAMERA] cleaning up stream...');
      if (myStream) {
        myStream.getTracks().forEach((track) => {
          console.log('[WEB][CAMERA] stopping track:', track.kind);
          track.stop();
        });
      }
      setLocalStream(null);
    };
  }, []);

  // 2) สร้าง PC + รับ ICE
  useEffect(() => {
    if (!localStream) return;

    console.log('[WEBRTC][WEB] create peerconnection');
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    // Add Local Tracks
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // Handle Remote Stream
    pc.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      console.log('[WEBRTC][WEB] ontrack remote stream received');
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
    };

    // Send Local ICE
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          event.candidate.toJSON()
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WEBRTC][WEB] iceConnectionState:', pc.iceConnectionState);
    };

    // รับ ICE จาก Mobile
    const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);
    const unsubscribeIce = onChildAdded(iceRef, async (snap) => {
      const cand = snap.val();
      if (cand && pcRef.current) {
        try {
          console.log('[ICE][WEB] adding remote candidate');
          await pcRef.current.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {
          console.error('[ICE][WEB] addIceCandidate error:', err);
        }
      }
    });

    return () => {
      console.log('[WEBRTC][WEB] cleanup pc');
      unsubscribeIce();
      pc.close();
      pcRef.current = null;
    };
  }, [localStream, roomId]);

  // 3) ฟัง Mobile Ready
  useEffect(() => {
    const readyRef = ref(db, `rooms/${roomId}/mobileReady`);
    const unsubscribe = onValue(readyRef, (snap) => {
      const ready = snap.val() === true;
      console.log('[SIGNAL][WEB] mobileReady status changed:', ready);
      setIsMobileReady(ready);
    });
    return () => unsubscribe();
  }, [roomId]);

  // 4) สร้าง Offer
  useEffect(() => {
    const pc = pcRef.current;
    if (!pc || !isMobileReady || offerSentRef.current) return;
    if (pc.signalingState !== 'stable') return;

    const createOffer = async () => {
      try {
        console.log('[SIGNAL][WEB] All systems go -> createOffer');
        offerSentRef.current = true;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await set(ref(db, `rooms/${roomId}/offer`), {
          type: offer.type,
          sdp: offer.sdp,
        });

        console.log('[SIGNAL][WEB] offer saved to Firebase');
      } catch (err) {
        console.error('[SIGNAL][WEB] createOffer error:', err);
        offerSentRef.current = false;
      }
    };

    createOffer();
  }, [isMobileReady, localStream, roomId]);

  // 5) ฟัง Answer
  useEffect(() => {
    const answerRef = ref(db, `rooms/${roomId}/answer`);
    const unsubscribe = onValue(answerRef, async (snap) => {
      const pc = pcRef.current;
      const data = snap.val();
      if (!pc || !data || pc.currentRemoteDescription) return;

      try {
        console.log('[SIGNAL][WEB] got answer -> setRemoteDescription');
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } catch (err) {
        console.error('[SIGNAL][WEB] setRemoteDescription error:', err);
      }
    });
    return () => unsubscribe();
  }, [roomId]);

  const handleLeave = async () => {
    try {
      console.log('[WEB] leaving room');
      // Cleanup PC
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }

      // Cleanup Stream (สำคัญ: หยุด Track ด้วย)
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
      }

      // Cleanup UI
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

      // Cleanup Firebase
      await remove(ref(db, `rooms/${roomId}`));

      onLeave();
    } catch (e) {
      console.warn(e);
      onLeave();
    }
  };

  return (
    <div className="min-h-screen bg-black flex flex-col">
      <div className="p-4 bg-gray-900 text-white flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold">ห้องสนทนา</h1>
          <p className="text-sm text-gray-300">Room: {roomId}</p>
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
          className="absolute inset-0 w-full h-full object-contain"
        />
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-6 right-6 w-40 h-56 rounded-xl object-cover border-2 border-gray-800 bg-gray-900"
        />

        {!isMobileReady && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-white bg-black/50 p-4 rounded-lg">
            รอแพทย์เข้าร่วมห้อง...
          </div>
        )}
      </div>

      <div className="p-4 bg-gray-900 text-gray-300 text-center">
        กำลังสนทนากับแพทย์: <span className="font-semibold">{doctorName}</span>
      </div>
    </div>
  );
}