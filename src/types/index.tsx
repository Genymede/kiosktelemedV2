export interface Location {
  id: string;
  name: string;
  active: boolean;
  address: {
    name: string;
    houseNo: string;
    moo: string;
    soi: string;
    road: string;
    subDistrict: string;
    district: string;
    province: string;
    postcode: string;
  };
}

export interface Doctor {
  id: string;
  name: string;
  specialty: string[]; // array เช่น ["ศัลยกรรมประสาท", "Sorcerer Supreme"]
  online: boolean;
  photoUrl: string;
  fcmToken?: string; // ไม่แสดงใน UI
}