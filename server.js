import express from "express";
import twilio from "twilio";
import sgMail from "@sendgrid/mail";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";

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

    const customerName = `${lead.first_name || ""} ${lead.surname || ""}`.trim();

    // 📩 SMS via Twilio
    await twilioClient.messages.create({
      body: 
`New lead assigned:

${lead.title || ""} ${customerName}
DOB: ${lead.dob || ""}
Amount Requested: ${lead.amount_requested || ""} over ${lead.loan_term || ""} weeks
Income: ${lead.income || ""}
Address: ${lead.address || ""}
Town: ${lead.town || ""}
Postcode: ${lead.postcode || ""}
Best Time To Call: ${lead.best_call_time || ""}
Collection Method: ${lead.method_collection || ""}

Once you have completed this loan, mark as issued with the link below: ${issueLink}`,
      from: twilioNumber,
      to: agent.phone,
    });

    // 📧 Email via SendGrid
    await sgMail.send({
      to: agent.email,
      from: "support@browsair.me",
      subject: `New Lead Assigned - ${customerName}`,
      text: 
`New lead assigned:

${lead.title || ""} ${customerName}
DOB: ${lead.dob || ""}
Amount Requested: ${lead.amount_requested || ""} over ${lead.loan_term || ""} weeks
Income: ${lead.income || ""}
Address: ${lead.address || ""}
Town: ${lead.town || ""}
Postcode: ${lead.postcode || ""}
Best Time To Call: ${lead.best_call_time || ""}
Collection Method: ${lead.method_collection || ""}

➡️ Mark Issued for ${customerName}: ${issueLink}`,
    });

    // 🔄 Update loan application with agent NAME + status + timestamp
    const { error: updateError } = await supabase
      .from("loan_applications")
      .update({
        status: "In Progress",
        assigned_agent: agent.name,
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
          from: "support@browsair.me",
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

// --- Webhook: lead-created ---
app.post("/lead-created", async (req, res) => {
  const newLead = req.body.record; // Supabase sends { type, table, record, schema }

  console.log("📩 Webhook received new lead:", newLead);

  if (!newLead?.company_name) {
    return res.status(400).json({ success: false, error: "Missing company_name" });
  }

  try {
    // Fetch managers for this company
    const { data: managers, error: mgrError } = await supabase
      .from("users") // or company_users table
      .select("id, email, phone, role, company_name")
      .eq("company_name", newLead.company_name)
      .eq("role", "manager");

    if (mgrError) throw mgrError;

    if (!managers?.length) {
      console.log(`⚠️ No managers found for ${newLead.company_name}`);
      return res.json({ success: true, message: "No managers to notify" });
    }

    // Build snapshot message
    const snapshot = `Lead: ${newLead.first_name || ""} ${newLead.surname || ""}, Amount: £${newLead.amount_requested || ""}`;
    const message = `Hello, a new lead has been submitted via the ${newLead.company_name} website.\n\n${snapshot}\n\nPlease login to your dashboard to view the full lead details.`;

    // Notify all managers
    for (const manager of managers) {
      // 📱 SMS via Twilio
      if (manager.phone) {
        await twilioClient.messages.create({
          body: message,
          from: twilioNumber,
          to: manager.phone,
        });
      }

      // 📧 Email via SendGrid
      if (manager.email) {
        await sgMail.send({
          to: manager.email,
          from: "support@browsair.me",
          subject: `New Lead Submitted - ${newLead.company_name}`,
          text: message,
        });
      }
    }

    res.json({ success: true, message: "Notifications sent" });

  } catch (err) {
    console.error("❌ Error sending notifications:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// 📊 Average Time To Issue (TTI) per agent
app.get("/avg-tti", async (req, res) => {
  try {
    const { company_name, branch_id } = req.query;

    let query = supabase
      .from("loan_applications")
      .select("assigned_agent, assigned_time, issued_time, company_name, assigned_branch")
      .eq("status", "Issued");

    if (company_name) query = query.eq("company_name", company_name);
    if (branch_id) query = query.eq("assigned_branch", branch_id);

    const { data, error } = await query;
    if (error) throw error;

    const results = {};
    data.forEach((row) => {
      if (row.assigned_agent && row.assigned_time && row.issued_time) {
        const diffMs = new Date(row.issued_time) - new Date(row.assigned_time);
        if (!results[row.assigned_agent]) results[row.assigned_agent] = [];
        results[row.assigned_agent].push(diffMs);
      }
    });

    const formatted = Object.entries(results).map(([agent, times]) => {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const days = Math.floor(avg / (1000 * 60 * 60 * 24));
      const hours = Math.floor((avg % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const mins = Math.floor((avg % (1000 * 60 * 60)) / (1000 * 60));
      return { assigned_agent: agent, avg_tti: `${days}d ${hours}h ${mins}m` };
    });

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error("❌ Error fetching TTI averages:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});





// --- Mark issued confirmation page ---
// --- Mark issued confirmation page ---
app.get("/mark-issued/:token", async (req, res) => {
  const { token } = req.params;
  const parts = token.split("-");

  // Extract UUID (5 parts of the token)
  const leadId = parts.slice(0, 5).join("-");
  if (!leadId) {
    return res.status(400).send("Invalid token");
  }

  try {
    // Fetch lead info (we need customer name)
    const { data: lead, error } = await supabase
      .from("loan_applications")
      .select("first_name, surname")
      .eq("id", leadId)
      .single();

    if (error || !lead) throw error;

    // Render confirmation HTML
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Confirm Loan Issued - ${lead.first_name} ${lead.surname}</title>

        <!-- SEO Meta -->
        <meta name="description" content="Confirm marking ${lead.first_name} ${lead.surname}'s loan as issued.">
        
        <!-- Open Graph (for WhatsApp, Messenger, etc.) -->
        <meta property="og:title" content="Confirm Loan Issued for ${lead.first_name} ${lead.surname}" />
        <meta property="og:description" content="Click confirm below to mark this loan as issued." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://bankbot-leads.onrender.com/mark-issued/${token}" />
        
        <!-- Twitter Card -->
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Confirm Loan Issued for ${lead.first_name} ${lead.surname}" />
        <meta name="twitter:description" content="Click confirm below to mark this loan as issued." />

        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 40px; }
          h2 { color: #2563eb; }
          button {
            background: #2563eb;
            color: white;
            border: none;
            padding: 12px 24px;
            font-size: 16px;
            border-radius: 6px;
            cursor: pointer;
          }
          button:hover { background: #1e40af; }
        </style>
      </head>
      <body>
        <h2>Mark ${lead.first_name} ${lead.surname}'s loan as Issued?</h2>
        <form method="POST" action="/confirm-issued/${token}">
          <button type="submit">✅ Confirm Mark as Issued</button>
        </form>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error showing confirm page:", err);
    res.status(500).send("Error loading confirmation page");
  }
});


// --- Confirm mark issued ---
app.post("/confirm-issued/:token", async (req, res) => {
  const { token } = req.params;
  const parts = token.split("-");

  const leadId = parts.slice(0, 5).join("-");
  if (!leadId) {
    return res.status(400).send("Invalid token");
  }

  try {
    // Fetch lead details for name
    const { data: lead, error: fetchError } = await supabase
      .from("loan_applications")
      .select("first_name, surname")
      .eq("id", leadId)
      .single();

    if (fetchError || !lead) throw fetchError;

    // Update status to Issued
    const { error } = await supabase
      .from("loan_applications")
      .update({
        status: "Issued",
        issued_time: new Date().toISOString()
      })
      .eq("id", leadId);

    if (error) throw error;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Loan Marked as Issued</title>
        <meta property="og:title" content="Loan Issued for ${lead.first_name} ${lead.surname}" />
        <meta property="og:description" content="This loan has been successfully marked as issued." />
        <meta property="og:type" content="website" />
      </head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 40px;">
        <h2>✅ ${lead.first_name} ${lead.surname}'s loan has been successfully marked as Issued</h2>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error marking issued:", err);
    res.status(500).send("Error marking issued");
  }
});



app.post("/assign-branch", async (req, res) => {
  const { leadId, branchId } = req.body;

  if (!leadId || !branchId) {
    return res.status(400).json({ success: false, error: "Missing leadId or branchId" });
  }

  try {
    const { error } = await supabase
      .from("loan_applications")
      .update({ assigned_branch: branchId })
      .eq("id", leadId);

    if (error) throw error;

    res.json({ success: true, message: "Branch assigned successfully" });
  } catch (err) {
    console.error("❌ Error assigning branch:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});






// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});







