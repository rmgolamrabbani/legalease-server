const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken'); 

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// =========================================================================
// Better Auth JWT Middleware 
// =========================================================================
const verifyJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ error: "Access Denied: No Token Provided" });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.BETTER_AUTH_SECRET);
    req.user = decoded; 
    next();
  } catch (error) {
    return res.status(403).send({ error: "Invalid or Expired Token" });
  }
};

// Root API
app.get('/', (req, res) => {
  res.send('Legal Ease Server is Running Successfully!');
});

// MongoDB Connection URI
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Error: MONGODB_URI is not defined in the environment variables.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB successfully!");
    
    const myDB = client.db("legal_ease");
    
    // Collections
    const usersCollection = myDB.collection("user");
    const profileCollection = myDB.collection("profile");
    const servicesCollection = myDB.collection("services");
    const ordersCollection = myDB.collection("orders");
    const reviewsCollection = myDB.collection("reviews");
    const requestsCollection = myDB.collection("requests");

    // =========================================================================
    // ১. লয়ার্স প্রোফাইল API 
    // =========================================================================
    
    app.get('/api/lawyers', async (req, res) => {
      try {
        const lawyers = await profileCollection.find({}).toArray();
        res.send(lawyers);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // নির্দিষ্ট লগইন করা লয়ারের ইমেইল অনুযায়ী প্রোফাইল ডাটা গেট করা
    app.get('/api/profile', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).send({ error: "Email query parameter is required" });

        const profile = await profileCollection.findOne({ email: email });
        if (profile) {
          res.send(profile);
        } else {
          res.send({
            name: "New Advocate",
            bio: "Please update your professional bio statement.",
            experience: "0 Years",
            hourlyRate: "0",
            category: "General Practice",
            status: "Available",
            avatarUrl: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150",
            email: email,
            createdAt: new Date()
          });
        }
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // নির্দিষ্ট লয়ারের প্রোফাইল আপডেট বা তৈরি
    app.put('/api/profile', async (req, res) => {
      try {
        const { email, name, bio, experience, hourlyRate, avatarUrl, category, status } = req.body;
        if (!email) return res.status(400).send({ error: "Email is required." });

        const filter = { email: email };
        const updateDoc = {
          $set: {
            name, bio, experience, hourlyRate, avatarUrl,
            category: category || "General Practice",
            status: status || "Available",
            email, updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        };
        
        const result = await profileCollection.updateOne(filter, updateDoc, { upsert: true });
        res.send({ success: true, result });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/api/profile/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid Object ID format" });
        const profile = await profileCollection.findOne({ _id: new ObjectId(id) });
        res.send(profile || {});
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // =========================================================================
    // ২. লয়ার সার্ভিস CRUD API 
    // =========================================================================
    app.get('/api/services', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).send({ error: "Email query required" });
        const result = await servicesCollection.find({ lawyerEmail: email }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.post('/api/services', async (req, res) => {
      try {
        const { title, cost, lawyerEmail } = req.body;
        const newService = { title, cost: parseFloat(cost), lawyerEmail, createdAt: new Date() };
        const result = await servicesCollection.insertOne(newService);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.delete('/api/services/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid ID" });
        const result = await servicesCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // =========================================================================
    // ৩. STRIPE PAYMENT INTEGRATION 
    // =========================================================================
    app.post('/api/create-checkout-session', async (req, res) => {
      const { lawyerId, amount, serviceTitle, userId, requestId, successUrl, cancelUrl } = req.body;
      try {
        if (!requestId || !amount) return res.status(400).send({ error: "Required fields missing." });

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: { name: serviceTitle || "Legal Consultation" },
              unit_amount: Math.round(amount * 100),
            },
            quantity: 1,
          }],
          mode: 'payment',
          metadata: { requestId: requestId },
          success_url: successUrl || `http://localhost:3000/dashboard/user/hiring-history?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: cancelUrl || `http://localhost:3000/dashboard/user/hiring-history`,
        });

        await ordersCollection.insertOne({
          sessionId: session.id, requestId, userId: userId || "user_123_test",
          lawyerId, amount, serviceTitle: serviceTitle || "Hourly Counseling",
          status: "Pending", createdAt: new Date()
        });

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.post('/api/verify-payment', async (req, res) => {
      const { sessionId } = req.body;
      try {
        if (!sessionId) return res.status(400).send({ error: "Session ID required." });

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status === 'paid') {
          await ordersCollection.updateOne({ sessionId: sessionId }, { $set: { status: "Paid" } });
          const requestId = session.metadata?.requestId;
          if (requestId && ObjectId.isValid(requestId)) {
            await requestsCollection.updateOne({ _id: new ObjectId(requestId) }, { $set: { paymentStatus: "Paid" } });
          }
          res.send({ success: true });
        } else {
          res.send({ success: false, message: "Payment not completed." });
        }
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/api/user-history/:userId', async (req, res) => {
      try {
        const history = await ordersCollection.find({ userId: req.params.userId, status: "Paid" }).toArray();
        res.send(history);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // =========================================================================
// ৪. REQUESTS (HIRING FLOW) 
// =========================================================================

app.post('/api/requests', async (req, res) => {
  try {
    const { lawyerId, lawyerName, userId, userName, userEmail, amount, serviceTitle } = req.body;
    
    // ডাইনামিক কুয়েরি মেচিং যাতে ডুপ্লিকেট চেক পারফেক্টলি হয়
    let duplicateQuery = { 
      userId: userId,
      status: { $in: ["Pending", "Accepted"] },
      $or: [{ lawyerId: lawyerId }, { lawyerId: String(lawyerId) }]
    };
    if (ObjectId.isValid(lawyerId)) duplicateQuery.$or.push({ lawyerId: new ObjectId(lawyerId) });

    const existingRequest = await requestsCollection.findOne(duplicateQuery);
    if (existingRequest) return res.status(400).send({ error: "Active request already exists." });

    const newRequest = { 
      lawyerId, 
      lawyerName, 
      userId, 
      userName, 
      userEmail, 
      amount, 
      serviceTitle, 
      status: "Pending", 
      paymentStatus: "Unpaid", 
      createdAt: new Date() 
    };
    
    const result = await requestsCollection.insertOne(newRequest);
    res.status(201).send({ success: true, insertedId: result.insertedId });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get('/api/user-requests/:userId', async (req, res) => {
  try {
    const result = await requestsCollection.find({ userId: req.params.userId }).sort({ createdAt: -1 }).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get('/api/lawyer-requests/:lawyerId', async (req, res) => {
  try {
    const id = req.params.lawyerId;
    
    // ডাটাবেজের lawyerId ফিল্ডের সাথে ম্যাচ করার জন্য কুয়েরি
    let query = {
      $or: [
        { lawyerId: id },
        { lawyerId: String(id) }
      ]
    };

   
    if (ObjectId.isValid(id)) {
      query.$or.push({ lawyerId: new ObjectId(id) });
    }

    // console.log("Backend Query:", JSON.stringify(query)); // ব্যাকএন্ড টার্মিনালে কুয়েরি দেখার জন্য

    const result = await requestsCollection.find(query).sort({ createdAt: -1 }).toArray();
    
    // console.log("Found Requests Count:", result.length); // কয়টি ডেটা পাওয়া গেল টার্মিনালে দেখাবে
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.patch('/api/requests/:id', async (req, res) => {
  try {
    const id = req.params.id;
    
    // ডাটাবেজে স্ট্রিং নাকি অবজেক্ট আইডি হিসেবে সেভ করা আছে তা চেক করে কুয়েরি তৈরি
    let query = { $or: [{ _id: id }, { _id: String(id) }] };
    if (ObjectId.isValid(id)) query.$or.push({ _id: new ObjectId(id) });

    const result = await requestsCollection.updateOne(query, { $set: { status: req.body.status } });
    
    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Request not found with this ID" });
    }
    
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.delete('/api/requests/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let query = { $or: [{ _id: id }, { _id: String(id) }] };
    if (ObjectId.isValid(id)) query.$or.push({ _id: new ObjectId(id) });

    const result = await requestsCollection.deleteOne(query);
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

    // =========================================================================
    // ৫. REVIEWS & DASHBOARD PROFILE INTERFACES
    // =========================================================================
    app.post('/api/reviews', async (req, res) => {
      try {
        const { lawyerId, lawyerName, userId, userName, comment, rating } = req.body;
        const newReview = { lawyerId, lawyerName: lawyerName || "Professional Lawyer", userId, userName, comment, rating, createdAt: new Date() };
        const result = await reviewsCollection.insertOne(newReview);
        res.status(201).send({ _id: result.insertedId, ...newReview });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/api/reviews/:lawyerId', async (req, res) => {
      try {
        const result = await reviewsCollection.find({ lawyerId: req.params.lawyerId }).sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/api/user-reviews/:userId', async (req, res) => {
      try {
        const result = await reviewsCollection.find({ userId: req.params.userId }).sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.put('/api/reviews/:id', async (req, res) => {
      try {
        const result = await reviewsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { comment: req.body.comment, rating: req.body.rating, updatedAt: new Date() } });
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.delete('/api/reviews/:id', async (req, res) => {
      try {
        const result = await reviewsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/api/check-payment-status', async (req, res) => {
      try {
        const { userId, lawyerId } = req.query;
        const order = await ordersCollection.findOne({ userId, lawyerId, status: "Paid" });
        const request = await requestsCollection.findOne({ userId, lawyerId, status: "Accepted", paymentStatus: "Paid" });
        res.send({ hasPaid: !!(order || request) });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // ড্যাশবোর্ড প্রোফাইল গেট
    app.get('/api/dashboard-profile', async (req, res) => {
      try {
        const { email, role } = req.query;
        if (!email) return res.status(400).send({ error: "Email required" });

        const profile = await profileCollection.findOne({ email, role });
        res.send(profile || { message: "Profile not found", email, role });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // ড্যাশবোর্ড প্রোফাইল আপডেট
    app.put('/api/dashboard-profile', async (req, res) => {
      try {
        const { email, role, name, bio, experience, hourlyRate, avatarUrl, phone, address, category, status } = req.body;
        if (!email) return res.status(400).send({ error: "Email validation failed" });

        const updateDoc = {
          $set: {
            name, role, avatarUrl, address, updatedAt: new Date(),
            ...(role === 'lawyer' && { bio, experience, hourlyRate, category, status }),
            ...(role === 'user' || role === 'admin') && { phone }
          },
        };
        const result = await profileCollection.updateOne({ email, role }, updateDoc, { upsert: true });
        res.send({ success: true, result });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });



    
    // =========================================================================
    // ৬. ADMIN API ENDPOINTS 
    // =========================================================================
    app.get('/api/admin/users', async (req, res) => {
      try {
        const result = await usersCollection.find({}).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.patch('/api/admin/users/role/:id', async (req, res) => {
      try {
        const result = await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role.toLowerCase(), updatedAt: new Date() } });
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.patch('/api/admin/users/block/:id', async (req, res) => {
      try {
        const result = await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isBlocked: req.body.isBlocked, updatedAt: new Date() } });
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.delete('/api/admin/users/:id', async (req, res) => {
      try {
        const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/api/admin/all-orders', async (req, res) => {
      try {
        const result = await ordersCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/api/admin/analytics', async (req, res) => {
      try {
        const allUsers = await usersCollection.find({}).toArray();
        const totalUsers = allUsers.filter(p => p.role?.toLowerCase() === 'user').length;
        const totalLawyers = allUsers.filter(p => p.role?.toLowerCase() === 'lawyer').length;
        
        const paidOrders = await ordersCollection.find({ status: "Paid" }).toArray();
        const totalHires = paidOrders.length;
        const totalRevenue = paidOrders.reduce((sum, order) => sum + (Number(order.amount) || 0), 0);

        res.send({ totalUsers, totalLawyers, totalHires, totalRevenue });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Ping check
    // await client.db("admin").command({ ping: 1 });
  } catch (error) {
    console.error("Database connection error:", error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});