import { auth, appOrigins, isTeamAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

const maxBytes=1024*1024;
function validImage(bytes:Buffer,type:string) {
  if (type==="image/png") return bytes.length>8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type==="image/jpeg") return bytes.length>3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff;
  if (type==="image/webp") return bytes.length>12 && bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP";
  return false;
}

export async function GET(request:Request) {
  const session=await auth.api.getSession({headers:request.headers});
  if (!session) return new Response("Logga in först.",{status:401});
  const playerId=new URL(request.url).searchParams.get("id");
  if (!playerId) return new Response("Spelaren saknas.",{status:400});
  const result=await db.query("SELECT photo,photo_type FROM roster_profile WHERE player_id=$1",[playerId]);
  if (!result.rows[0]?.photo) return new Response("Bilden saknas.",{status:404});
  return new Response(result.rows[0].photo,{headers:{"Content-Type":result.rows[0].photo_type,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}

export async function POST(request:Request) {
  const session=await auth.api.getSession({headers:request.headers});
  if (!session) return Response.json({error:"Logga in först."},{status:401});
  const origin=request.headers.get("origin");
  if (!origin || !appOrigins().includes(origin)) return Response.json({error:"Ogiltigt ursprung."},{status:403});
  const contentLength=Number(request.headers.get("content-length")??0);
  if (contentLength>maxBytes+64*1024) return Response.json({error:"Bilden får vara högst 1 MiB."},{status:413});
  const form=await request.formData().catch(()=>null);
  const playerId=String(form?.get("playerId")??"");
  if (!playerId) return Response.json({error:"Spelaren saknas."},{status:400});
  const admin=await isTeamAdmin(session.user.id,session.user.email);
  const owner=await db.query("SELECT id FROM roster WHERE id=$1 AND user_id=$2",[playerId,session.user.id]);
  if (!admin && !owner.rowCount) return Response.json({error:"Du får bara ändra din egen spelarbild."},{status:403});
  if (form?.get("remove")==="1") {
    await db.query("UPDATE roster_profile SET photo=NULL,photo_type=NULL,updated_at=now() WHERE player_id=$1",[playerId]);
    return Response.json({ok:true});
  }
  const file=form?.get("photo");
  if (!(file instanceof File) || !file.size || file.size>maxBytes) return Response.json({error:"Välj en bild på högst 1 MiB."},{status:400});
  const bytes=Buffer.from(await file.arrayBuffer());
  if (!validImage(bytes,file.type)) return Response.json({error:"Bilden måste vara en giltig JPEG-, PNG- eller WebP-fil."},{status:400});
  await db.query("INSERT INTO roster_profile(player_id,photo,photo_type) VALUES($1,$2,$3) ON CONFLICT(player_id) DO UPDATE SET photo=$2,photo_type=$3,updated_at=now()",[playerId,bytes,file.type]);
  return Response.json({ok:true});
}
