// Shadow Push 触发端点
// 这个函数被外部cron调用，检查是否应该推送
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

serve(async (req) => {
  // 验证secret
  const secret = req.headers.get('x-push-secret');
  if (secret !== Deno.env.get('PUSH_SECRET')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401,
      headers: { 'Cache-Control': 'no-store' }
    });
  }
  
  try {
    // 调用shadow-push函数
    const response = await fetch(`${supabaseUrl}/functions/v1/shadow-push`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
        'x-push-secret': secret
      },
      body: JSON.stringify({})
    });
    
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
