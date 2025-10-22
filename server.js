import express from "express";
import twilio from "twilio";
import sgMail from "@sendgrid/mail";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";

// 🔑 Generate a unique token for marking issued
function generateIssueToken(leadId) {
  const token = crypto.randomBytes(16).toString("hex");
  return `${leadId}-${token}`;
}

dotenv.config();

const app = express();

// 🔓 Allow frontend (Vite default is 5173)
app.use(cors({
  origin: "*", // or "*" for testing all origins
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// --- Supabase ---
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY // ⚠️ service role key for server only
);

// --- Twilio ---
const twilioClient = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH
);
const twilioNumber = process.env.TWILIO_NUMBER;

// --- SendGrid ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Test route ---
app.get("/", (req, res) => {
  res.send("BankBot local server running 🚀");
});



// --- Assign lead route ---
// --- Assign lead route ---
app.post("/assign-lead", async (req, res) => {
  const { lead, agentId } = req.body;

  if (!lead || !agentId) {
    return res.status(400).json({ success: false, error: "Missing lead or agentId" });
  }

  try {
    // 🔍 Fetch agent details from Supabase by ID
    const { data: agent, error } = await supabase
      .from("agents")
      .select("id, name, email, phone")
      .eq("id", agentId)
      .single();

    if (error || !agent) throw new Error("Agent not found");

    // 🔑 Generate secure token + link
    const token = generateIssueToken(lead.id);
    const issueLink = `https://bankbot-leads.onrender.com/mark-issued/${token}`;

    // 📩 SMS via Twilio
    await twilioClient.messages.create({
      body: 
`New lead assigned:

${lead.title || ""} ${lead.first_name || ""} ${lead.surname || ""}
DOB: ${lead.dob || ""}
Amount Requested: ${lead.amount_requested || ""} over ${lead.loan_term || ""} weeks
Income: ${lead.income || ""}
Address: ${lead.address || ""}
Town: ${lead.town || ""}
Postcode: ${lead.postcode || ""}
Best Time To Call: ${lead.best_call_time || ""}
Collection Method: ${lead.method_collection || ""}

➡️ Mark as Issued: ${issueLink}`,
      from: twilioNumber,
      to: agent.phone,
    });

    // 📧 Email via SendGrid (optional — includes issue link too)
    await sgMail.send({
      to: agent.email,
      from: "info@handy-digital.com",
      subject: `New Lead Assigned - ${lead.first_name || ""} ${lead.surname || ""}`,
      text: 
`New lead assigned:

${lead.title || ""} ${lead.first_name || ""} ${lead.surname || ""}
DOB: ${lead.dob || ""}
Amount Requested: ${lead.amount_requested || ""} over ${lead.loan_term || ""} weeks
Income: ${lead.income || ""}
Address: ${lead.address || ""}
Town: ${lead.town || ""}
Postcode: ${lead.postcode || ""}
Best Time To Call: ${lead.best_call_time || ""}
Collection Method: ${lead.method_collection || ""}

➡️ Mark as Issued: ${issueLink}`,
    });

    // 🔄 Update loan application with agent NAME + status + timestamp
    const { error: updateError } = await supabase
      .from("loan_applications")
      .update({
        status: "In Progress",
        assigned_agent: agent.name,   // ✅ store name instead of UUID
        assigned_time: new Date().toISOString()
      })
      .eq("id", lead.id);

    if (updateError) throw updateError;

    res.json({ success: true, message: `Lead assigned to ${agent.name}` });
  } catch (err) {
    console.error("❌ Error assigning lead:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// --- Send template route ---
app.post("/send-template", async (req, res) => {
  const { lead, type, company_name } = req.body;

  if (!lead || !type || !company_name) {
    return res.status(400).json({ success: false, error: "Missing lead, type, or company_name" });
  }

  try {
    // 🔍 Fetch templates for this company + type
    const { data: templates, error: templateError } = await supabase
      .from("message_templates")
      .select("channel, subject, body")
      .eq("company_name", company_name)
      .eq("type", type);

    if (templateError || !templates?.length) {
      throw new Error("No templates found");
    }

    // Loop through templates (sms + email)
    for (const t of templates) {
      if (t.channel === "sms" && lead.phone_number) {
        await twilioClient.messages.create({
          body: t.body,
          from: twilioNumber,
          to: lead.phone_number, // ✅ customer’s phone
        });
      }

      if (t.channel === "email" && lead.email) {
        await sgMail.send({
          to: lead.email, // ✅ customer’s email
          from: "info@handy-digital.com",
          subject: t.subject || `Notification from ${company_name}`,
          text: t.body,
        });
      }
    }
    

    // 🔄 Update lead status to the chosen type
    await supabase
      .from("loan_applications")
      .update({ status: type })
      .eq("id", lead.id);

    res.json({ success: true, message: `${type} template sent for ${company_name}` });
  } catch (err) {
    console.error("Error sending template:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});





// --- Mark as issued route ---
app.post("/mark-issued", async (req, res) => {
  const { lead } = req.body;

  if (!lead?.id) {
    return res.status(400).json({ success: false, error: "Missing lead id" });
  }

  try {
    const { error } = await supabase
      .from("loan_applications")
      .update({ 
        status: "Issued",
        issued_time: new Date().toISOString()
       })
      .eq("id", lead.id);

    if (error) throw new Error(error.message);

    res.json({ success: true, message: "Lead marked as Issued" });
  } catch (err) {
    console.error("Error marking issued:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});




// --- Mark issued via token ---
app.get("/mark-issued/:token", async (req, res) => {
  const { token } = req.params;
  const leadId = token.substring(0, token.lastIndexOf("-"));

  if (!leadId) {
    return res.status(400).send("Invalid token");
  }

  try {
    const { data: lead, error } = await supabase
      .from("loan_applications")
      .select("first_name, surname")
      .eq("id", leadId)
      .single();

    if (error || !lead) throw error;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Update Loan Status - ${lead.first_name} ${lead.surname}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding: 40px;
            background-color: #f9fafb;
          }
          h2 { color: #2563eb; }
          button {
            background: #2563eb;
            color: white;
            border: none;
            padding: 12px 24px;
            font-size: 16px;
            border-radius: 6px;
            cursor: pointer;
            margin: 10px;
          }
          button:hover { background: #1e40af; }
          .decline { background: #dc2626; }
          .contact { background: #ca8a04; }
          .no-need { background: #9333ea; }
          .decline:hover { background: #991b1b; }
          .contact:hover { background: #92400e; }
          .no-need:hover { background: #7e22ce; }
        </style>
      </head>
      <body>
        <h2>Update status for ${lead.first_name} ${lead.surname}</h2>

        <form method="POST" action="/confirm-status/${token}?status=Issued">
          <button type="submit">✅ Mark as Issued</button>
        </form>

        <form method="POST" action="/confirm-status/${token}?status=Agent Declined">
          <button type="submit" class="decline">❌ Agent Declined</button>
        </form>

        <form method="POST" action="/confirm-status/${token}?status=Unable to Contact">
          <button type="submit" class="contact">📞 Unable to Contact</button>
        </form>

        <form method="POST" action="/confirm-status/${token}?status=No Longer Needed">
          <button type="submit" class="no-need">💭 No Longer Needed</button>
        </form>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error showing confirm page:", err);
    res.status(500).send("Error loading confirmation page");
  }
});

app.post("/confirm-status/:token", async (req, res) => {
  const { token } = req.params;
  const leadId = token.substring(0, token.lastIndexOf("-"));
  const status = req.query.status || "Unknown";

  if (!leadId) {
    return res.status(400).send("Invalid token");
  }

  try {
    const { data: lead, error: fetchError } = await supabase
      .from("loan_applications")
      .select("first_name, surname")
      .eq("id", leadId)
      .single();

    if (fetchError || !lead) throw fetchError;

    // 🧾 Update status and timestamp
    const { error } = await supabase
      .from("loan_applications")
      .update({
        status,
        issued_time: new Date().toISOString(),
      })
      .eq("id", leadId);

    if (error) throw error;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Status Updated</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 40px; background: #f9fafb; }
          h2 { color: #2563eb; }
        </style>
      </head>
      <body>
        <h2>✅ ${lead.first_name} ${lead.surname}'s loan updated to: "${status}"</h2>
        <p>You can now close this page.</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error updating loan status:", err);
    res.status(500).send("Error updating status");
  }
});





// --- Webhook: lead-created ---
app.post("/lead-created", async (req, res) => {
  const newLead = req.body.record; // Supabase sends { type, table, record, schema }

  console.log("📩 Webhook received new lead:", newLead);

  if (!newLead?.company_name) {
    return res
      .status(400)
      .json({ success: false, error: "Missing company_name" });
  }

  try {
    // ✅ Fetch admins for this company (not managers)
    const { data: admins, error: adminError } = await supabase
      .from("users")
      .select("id, email, phone, role, company_name, lead_notifications")
      .eq("company_name", newLead.company_name)
      .eq("role", "admin")
      .eq("lead_notifications", true); // only notify opted-in users

    if (adminError) throw adminError;

    if (!admins?.length) {
      console.log(`⚠️ No admins found for ${newLead.company_name}`);
      return res.json({ success: true, message: "No admins to notify" });
    }

    // ✅ Build snapshot message with dashboard link
const dashboardUrl = `https://handy-digital-leads.co.uk`;

const snapshot = `Lead: ${newLead.first_name || ""} ${
  newLead.surname || ""
}, Amount: £${newLead.amount_requested || ""}`;

const message = `📩 A new lead has been submitted via ${newLead.company_name}.
\n${snapshot}\n\nPlease log in to your dashboard to review full details:\n${dashboardUrl}`;

    // ✅ Notify all admins (SMS + Email)
    for (const admin of admins) {
      // SMS via Twilio
      if (admin.phone) {
        await twilioClient.messages.create({
          body: message,
          from: twilioNumber,
          to: admin.phone,
        });
      }

      // Email via SendGrid
      if (admin.email) {
        await sgMail.send({
          to: admin.email,
          from: "info@handy-digital.com",
          subject: `New Lead Submitted - ${newLead.company_name}`,
          text: message,
        });
      }
    }

    res.json({ success: true, message: "Admin notifications sent" });
  } catch (err) {
    console.error("❌ Error sending admin notifications:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// 📊 Average Time To Issue (TTI) per agent (filtered by company + branch)
app.get("/avg-tti", async (req, res) => {
  try {
    const { company_name, branch } = req.query; // 👈 now using 'branch'
    console.log("📥 /avg-tti request received:", { company_name, branch });

    // 🧩 Call the RPC
    const { data, error } = await supabase.rpc("get_avg_tti");
    if (error) throw error;

    console.log("📊 Raw rows returned from RPC:", data?.length || 0);

    // 🧮 Filter logic
    const filtered = data.filter((row) => {
      const companyMatch =
        !company_name ||
        (row.company_name &&
          row.company_name.trim().toLowerCase() ===
            company_name.trim().toLowerCase());

      const branchMatch =
        !branch ||
        (row.assigned_branch &&
          row.assigned_branch.toString() === branch.toString());

      return companyMatch && branchMatch;
    });

    console.log("✅ Filtered rows after match:", filtered?.length || 0);

    // 🕓 Format intervals
    const formatted = filtered.map((row) => {
      const interval = row.avg_tti_interval; // e.g. "1 day 03:22:00"
      let days = 0,
        hours = 0,
        mins = 0;

      if (interval) {
        const match = interval.match(/(\d+)\s+days?/);
        if (match) days = parseInt(match[1], 10);

        const timeMatch = interval.match(/(\d+):(\d+):/);
        if (timeMatch) {
          hours = parseInt(timeMatch[1], 10);
          mins = parseInt(timeMatch[2], 10);
        }
      }

      return {
        assigned_agent: row.assigned_agent,
        company_name: row.company_name,
        avg_tti: `${days}d ${hours}h ${mins}m`,
      };
    });

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error("❌ Error fetching TTI averages:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// --- 📦 Assign Branch + Notify Only Branch Managers ---
app.post("/assign-branch", async (req, res) => {
  const { leadId, branchId } = req.body;

  if (!leadId || !branchId) {
    return res.status(400).json({
      success: false,
      error: "Missing leadId or branchId",
    });
  }

  try {
    console.log(`📩 Assigning branch ${branchId} to lead ${leadId}`);

    // ✅ 1. Update lead’s assigned_branch and fetch lead details
    const { data: updatedLead, error: updateError } = await supabase
      .from("loan_applications")
      .update({ assigned_branch: branchId })
      .eq("id", leadId)
      .select()
      .single();

    if (updateError) throw updateError;

    if (!updatedLead) {
      return res
        .status(404)
        .json({ success: false, error: "Lead not found after update" });
    }

    // ✅ 2. Fetch managers for this company + branch
    const { data: managers, error: mgrError } = await supabase
      .from("users")
      .select("id, email, phone, role, company_name, branch, lead_notifications")
      .eq("company_name", updatedLead.company_name)
      .eq("branch", branchId)
      .eq("role", "manager")
      .eq("lead_notifications", true);

    if (mgrError) throw mgrError;

    if (!managers?.length) {
      console.log(
        `⚠️ No managers found for branch ${branchId} (${updatedLead.company_name})`
      );
      return res.json({
        success: true,
        message: "Branch assigned successfully (no managers found for notification)",
      });
    }

    // ✅ 3. Prepare message
    const snapshot = `Lead: ${updatedLead.first_name || ""} ${
      updatedLead.surname || ""
    }\nAmount: £${updatedLead.amount_requested || ""}\nReason: ${
      updatedLead.reason_for_borrowing || ""
    }`;

    const dashboardUrl = `https://handy-digital-leads.co.uk`;
    const message = `📩 A new lead has been assigned to your branch under ${updatedLead.company_name}.
\n${snapshot}\n\nView Lead: ${dashboardUrl}`;

    // ✅ 4. Notify branch managersS
    for (const manager of managers) {
      // SMS
      if (manager.phone) {
        await twilioClient.messages.create({
          body: message,
          from: twilioNumber,
          to: manager.phone,
        });
      }

      // Email
      if (manager.email) {
        await sgMail.send({
          to: manager.email,
          from: "info@handy-digital.com",
          subject: `New Lead Assigned - ${updatedLead.company_name}`,
          text: message,
        });
      }
    }

    // ✅ 5. Respond success
    res.json({
      success: true,
      message: "Branch assigned and managers notified",
    });
  } catch (err) {
    console.error("❌ Error assigning branch or notifying managers:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// (Optional) tiny helper – in case a raw UK number slips through
const toE164UK = (n) => {
  if (!n) return n;
  const digits = String(n).replace(/\D/g, "");
  if (digits.startsWith("44")) return `+${digits}`;
  if (digits.startsWith("0")) return `+44${digits.slice(1)}`;
  if (digits.startsWith("+")) return digits;
  return `+44${digits}`;
};
// call-lead.js (part of your Express server)
app.post("/call-lead", async (req, res) => {
  const lead = req.body || {};
  const phone = toE164UK(lead.phone_number); // 👈 matches your Supabase field

  console.log("📞 Received lead:", lead.first_name, phone);

  try {
    const payload = {
  assistantId: process.env.VAPI_ASSISTANT_ID,
  phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
  customer: { number: phone },
  assistantOverrides: {
    variableValues: {
      name: lead.first_name,
      dob: lead.dob,
      postcode: lead.postcode,
      amount_requested: String(lead.amount_requested ?? ""),
      preferred_call_time: lead.preferred_call_time || "",
      reason_for_borrowing: lead.reason_for_borrowing || "",
    },
  },
  metadata: {
    lead_id: lead.id,
    company_name: lead.company_name,
  },
  webhookUrl: process.env.VAPI_WEBHOOK_URL
};


    const resp = await axios.post("https://api.vapi.ai/call", payload, {
      headers: {
        Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });

    console.log("✅ Vapi call created:", resp.data);
    res.json({ success: true, vapi: resp.data });
  } catch (err) {
    console.error("❌ Vapi call error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});


app.post("/vapi/callback", async (req, res) => {
  const event = req.body;
  console.log("📨 Vapi event:", JSON.stringify(event, null, 2));

  const leadId = event.metadata?.lead_id;
  const callId = event.id;
  const transcript = event.transcript?.text || null;
  const status = event.status || event.type || "unknown";

  if (!leadId) {
    console.warn("⚠️ No lead_id in event metadata – cannot match");
    return res.sendStatus(200);
  }

  try {
    const { data, error } = await supabase
      .from("voice_call_1")
      .insert({
        lead_id: leadId,
        vapi_call_id: callId,
        phone_number: event.customer?.number,
        transcript,
        status,
      });

    if (error) throw error;
    console.log(`✅ Logged Vapi call for lead ${leadId}`);
  } catch (err) {
    console.error("❌ Failed to store call:", err.message);
  }

  res.sendStatus(200);
});



// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});


