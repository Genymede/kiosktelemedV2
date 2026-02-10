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

  // ใช้ Google STUN Servers (ถ้าใช้ในมหาลัย/หอพัก อาจต้องใช้ TURN Server เพิ่ม)
  const pcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  };

  // 0) Cleanup
  useEffect(() => {
    const base = `rooms/${roomId}`;
    console.log('[ROOM] init cleanup (safe):', roomId);

    remove(ref(db, `${base}/offer`));
    remove(ref(db, `${base}/answer`));
    remove(ref(db, `${base}/candidates`));

    offerSentRef.current = false;
    setIsMobileReady(false);
  }, [roomId]);

  // 1) เปิดกล้อง
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
      // Cleanup stream when unmount
    };
  }, []);

  // 2) สร้าง PC + ✅ รวม Logic รับ ICE Candidate ไว้ที่นี่
  useEffect(() => {
    if (!localStream) return;

    console.log('[WEBRTC][WEB] create peerconnection');
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    // ... (ส่วน Add Track และ ontrack เหมือนเดิม) ...
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

    // Handle ICE Candidates (Send to Firebase)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          event.candidate.toJSON()
        );
      }
    };

    // Monitor Connection State
    pc.oniceconnectionstatechange = () => {
      console.log('[WEBRTC][WEB] iceConnectionState:', pc.iceConnectionState);
    };

    // ✅ ส่วนรับ ICE Candidate
    const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);

    // เก็บฟังก์ชัน unsubscribe ไว้ในตัวแปร
    const unsubscribeIce = onChildAdded(iceRef, async (snap) => {
      const cand = snap.val();
      if (cand && pcRef.current) {
        try {
          // console.log('[ICE][WEB] adding remote candidate'); 
          await pcRef.current.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {
          console.error('[ICE][WEB] addIceCandidate error:', err);
        }
      }
    });

    return () => {
      console.log('[WEBRTC][WEB] cleanup pc');

      // ✅ เรียกใช้ unsubscribeIce() ตรงนี้แทน off(iceRef)
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

  // 4) สร้าง Offer (เมื่อ PC พร้อม + Mobile พร้อม)
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

  // ส่วน Leave (เหมือนเดิม)
  const handleLeave = async () => {
    try {
      console.log('[WEB] leaving room');
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
      }

      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

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
        <button onClick={handleLeave} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-semibold">
          วางสาย
        </button>
      </div>

      <div className="flex-1 relative bg-black">
        <video ref={remoteVideoRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-contain" />
        <video ref={localVideoRef} autoPlay playsInline muted className="absolute bottom-6 right-6 w-40 h-56 rounded-xl object-cover border-2 border-gray-800 bg-gray-900" />

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