//backend/index.js
require("dotenv").config();
const upload = require("./utils/cloudinary");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const verifyToken = require('./middlewares/verifyToken');
const Item = require("./models/Item");

const app = express();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sendNotification = require("./utils/mailer");

// CORS configuration for production
app.use(cors({
  origin: ['http://localhost:3000', 'https://lostfound-api.netlify.app'],
  credentials: true
}));

app.use(express.json());
console.log("DEBUG MONGO_URI:", process.env.MONGO_URI);

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

// Test route
app.get("/", (req, res) => {
  res.send("Lost & Found API running!");
});

// -----------------------------
// 🔐 Admin Auth Routes
// -----------------------------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

const JWT_SECRET = process.env.JWT_SECRET || "secret123";

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || !bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});


// POST /api/items - Submit new item


app.post("/api/items", upload.array("images", 5), async (req, res) => {
  try {
    const { title, description, category, type, location, date, contactInfo, submittedBy, userEmail,studentId, phone} = req.body;

    if (!title || !description || !location || !type || !contactInfo || !submittedBy || !userEmail) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!['lost', 'found'].includes(type)) {
      return res.status(400).json({ message: "Invalid item type" });
    }



    const imageUrls = req.files?.map(file => file.path) || [];
    const contactEmail = contactInfo && /\S+@\S+\.\S+/.test(contactInfo)
  ? contactInfo
  : userEmail;


    const newItem = new Item({
      title,
      description,
      category,
      type,
      location,
      date,
      contactInfo :contactEmail,
      submittedBy,
      userEmail,
      phone,
      schoolId: studentId,
      status: "pending",
       imageUrl: imageUrls[0] || "", // main image
      images: imageUrls,       // optional array field
      submittedAt: new Date()
    });

    await newItem.save();

    await sendNotification(userEmail, "Lost & Found Submission Received", `
Hi ${submittedBy},

We've received your ${type} item submission: "${title}" at ${location}.
You'll be notified once it is reviewed.

Thanks,
Lost & Found Team
    `);

    res.status(201).json({ message: "Item submitted successfully", item: newItem });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/items/:id/moderate", verifyToken, async (req, res) => {
  try {
    const { status, moderatorName } = req.body;

    const item = await Item.findByIdAndUpdate(
      req.params.id,
      {
        status,
        moderatedBy: moderatorName || 'Admin',
        moderatedAt: new Date()
      },
      { new: true }
    );

    // ✅ Only proceed with email if approved
    if (status === "approved") {
  const matchTargetType = item.type === "found" ? "lost" : "found";

// Remove location filter — match based on partial title (case-insensitive)
const matchingItems = await Item.find({
  type: matchTargetType,
  status: "approved",
  resolved: { $ne: true },
  title: { $regex: item.title, $options: "i" } // partial & case-insensitive match
});


  for (const match of matchingItems) {
    const recipientEmails = [];

    if (match.contactInfo) recipientEmails.push(match.contactInfo);
    if (match.userEmail) recipientEmails.push(match.userEmail);

    // ✅ Compose cleaner message
    const body = `
Hi there,

We’ve found an item titled "${item.title}" in "${item.location}" that may match something you reported as ${matchTargetType}.

Please visit the Lost & Found portal to verify the details.

Thanks,  
Lost & Found Team
`;

    for (const email of recipientEmails) {
      if (email && /\S+@\S+\.\S+/.test(email)) {
        console.log(`📨 Sending match email to: ${email}`);
        await sendNotification(
          email,
          "🔔 Possible Match Found for Your Item!",
          body // ✅ Use clean message body here
        );
      }
    }
  }
}

    res.json(item);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});



// GET /api/items - Get approved items only (public)
app.get("/api/items", async (req, res) => {
  try {
    const { type, location, category, search, userEmail } = req.query;
    let filter = { status: 'approved' }; // Only show approved items

    if (type) filter.type = type;
    if (location) filter.location = { $regex: location, $options: "i" };
    if (category) filter.category = category;
    
    if (search && userEmail) {
  filter = {
    $and: [
      { userEmail: userEmail },
      {
        $or: [
          { title: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
          { location: { $regex: search, $options: "i" } },
          { userEmail: { $regex: search, $options: "i" } },
          { submittedBy: { $regex: search, $options: "i" } }
        ]
      }
    ]
  };
} else if (search) {
  filter.$or = [
    { title: { $regex: search, $options: "i" } },
    { description: { $regex: search, $options: "i" } },
    { location: { $regex: search, $options: "i" } },
    { userEmail: { $regex: search, $options: "i" } },
    { submittedBy: { $regex: search, $options: "i" } }
  ];
} else if (userEmail) {
  filter.userEmail = userEmail;
}




    const items = await Item.find(filter).sort({ submittedAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }


});
app.get("/api/categories", async (req, res) => {
  try {
    const categories = await Item.distinct('category');
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Admin routes
app.get("/api/admin/items", verifyToken, async (req, res) => {

  try {
    const items = await Item.find().sort({ submittedAt: -1 });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// DELETE item by admin
app.delete("/api/admin/items/:id", verifyToken, async (req, res) => {
  try {
    const deleted = await Item.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Item not found" });
    res.json({ message: "Item deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Mark item as resolved
app.put("/api/admin/items/:id/resolve", verifyToken, async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });

    item.resolved = true;
    item.resolvedBy = "Admin"; // clearly marked
     item.resolvedAt = new Date();
    await item.save();
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.put("/api/items/:id/resolve", async (req, res) => {
  try {
    const { email } = req.body;
    const item = await Item.findById(req.params.id);

    if (!item) return res.status(404).json({ message: "Item not found" });

    // Only allow the person who submitted it to resolve
    if (item.userEmail !== email) {
      return res.status(403).json({ message: "Unauthorized to resolve this item" });
    }

    item.resolved = true;
    item.resolvedBy = email;
    item.resolvedAt = new Date();
    await item.save();
    res.json({ message: "Item marked as resolved", item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Claiming an item as a user (mark as resolved)
app.put("/api/items/:id/claim", async (req, res) => {
  try {
    const { name, email, rollNo } = req.body;

    if (!name || !email || !rollNo) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });

    if (item.resolved) return res.status(400).json({ message: "Item already resolved" });

    item.resolved = true;
    item.resolvedAt = new Date();
    item.resolvedBy = `${name} (${rollNo})`;
    item.claimedInfo = { name, email, rollNo };

    await item.save();
    res.json({ message: "Item successfully claimed and marked as resolved", item });
  } catch (err) {
    console.error("Claim error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});


// Get categories for dropdown
app.get("/api/categories",verifyToken, async (req, res) => {
  try {
    const categories = await Item.distinct('category');
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
