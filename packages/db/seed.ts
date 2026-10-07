import { db } from "./src/client";
import { clinics, users, doctors, chairs } from "./src/schema";

async function seed() {
  console.log("🌱 Starting seed...");

  // Create two clinics
  const clinic1 = await db
    .insert(clinics)
    .values({
      name: "Klinik Maltepe",
      slug: "klinik-maltepe",
      phone: "+90 212 123 4567",
      address: "Maltepe, İstanbul",
      plan: "starter",
    })
    .returning();

  const clinic2 = await db
    .insert(clinics)
    .values({
      name: "Klinik Bakırköy",
      slug: "klinik-bakirkoy",
      phone: "+90 212 765 4321",
      address: "Bakırköy, İstanbul",
      plan: "starter",
    })
    .returning();

  console.log("✅ Created clinics:", {
    clinic1: clinic1[0].id,
    clinic2: clinic2[0].id,
  });

  // Create owner/admin users for each clinic
  const user1 = await db
    .insert(users)
    .values({
      clinic_id: clinic1[0].id,
      role: "owner",
      full_name: "Ahmet Yılmaz",
      email: "ahmet@klinik-maltepe.com",
      phone: "+90 555 111 1111",
      color: "#FF6B6B",
    })
    .returning();

  const user2 = await db
    .insert(users)
    .values({
      clinic_id: clinic2[0].id,
      role: "owner",
      full_name: "Fatma Kaya",
      email: "fatma@klinik-bakirkoy.com",
      phone: "+90 555 222 2222",
      color: "#4ECDC4",
    })
    .returning();

  console.log("✅ Created users:", {
    user1: user1[0].id,
    user2: user2[0].id,
  });

  // Create doctors
  const doctor1 = await db
    .insert(doctors)
    .values({
      clinic_id: clinic1[0].id,
      user_id: user1[0].id,
      specialty: "Genel Diş Hekimi",
      slot_minutes: 30,
    })
    .returning();

  const doctor2 = await db
    .insert(doctors)
    .values({
      clinic_id: clinic2[0].id,
      user_id: user2[0].id,
      specialty: "Ortodontist",
      slot_minutes: 45,
    })
    .returning();

  console.log("✅ Created doctors:", {
    doctor1: doctor1[0].id,
    doctor2: doctor2[0].id,
  });

  // Create chairs for each clinic
  await db
    .insert(chairs)
    .values([
      {
        clinic_id: clinic1[0].id,
        name: "Koltuk 1",
        sort_order: 1,
      },
      {
        clinic_id: clinic1[0].id,
        name: "Koltuk 2",
        sort_order: 2,
      },
      {
        clinic_id: clinic2[0].id,
        name: "OP 1",
        sort_order: 1,
      },
      {
        clinic_id: clinic2[0].id,
        name: "OP 2",
        sort_order: 2,
      },
    ])
    .returning();

  console.log("✅ Created chairs");

  console.log("🎉 Seed completed!");
}

seed().catch((error) => {
  console.error("❌ Seed failed:", error);
  process.exit(1);
});
