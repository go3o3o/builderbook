import _ from "lodash";
import mongoose, { Schema } from "mongoose";

import generateSlug from "../utils/slugify";

const mongoSchema = new Schema({
  googleId: {
    type: String,
    required: true,
    unique: true,
  },
  googleToken: {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expiry_date: Number,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  displayName: String,
  avatarUrl: String,

  purchasedBookIds: [String],
  freeBookIds: [String],

  isGithubConnected: {
    type: Boolean,
    default: false,
  },
  githubAccessToken: {
    type: String,
  },
  tos: String,
});

class UserClass {
  static publicFields() {
    return [
      "id",
      "displayName",
      "email",
      "avatarUrl",
      "slug",
      "isAdmin",
      "isGithubConnected",
      "purchasedBookIds",
      "freeBookIds",
    ];
  }

  static search(query) {
    return this.find(
      {
        $or: [
          { displayName: { $regex: query, $options: "i" } },
          { email: { $regex: query, $options: "i" } },
        ],
      },
      UserClass.publicFields().join(" ")
    );
  }

  static async signInOrSignUp({
    googleId,
    email,
    googleToken,
    displayName,
    avatarUrl,
  }) {
    const user = await this.findOne({ googleId }).select(
      UserClass.publicFields().join(" ")
    );

    if (user) {
      const modifier = {};
      Object.keys(googleToken || {}).forEach((k) => {
        if (googleToken[k]) {
          modifier[`googleToken.${k}`] = googleToken[k];
        }
      });

      if (_.isEmpty(modifier)) {
        return user;
      }

      await this.updateOne({ googleId }, { $set: modifier });

      return user;
    }

    const slug = await generateSlug(this, displayName);
    const userCount = await this.find().count();
    const demo = !!process.env.DEMO;

    const newUser = await this.create({
      createdAt: new Date(),
      googleId,
      email,
      googleToken,
      displayName,
      avatarUrl,
      slug,
      isAdmin: userCount === 0 || demo,
    });

    /*
    const template = await getEmailTemplate('welcome', {
      userName: displayName,
    });

    try {
      await sendEmail({
        from: `Kelly from Builder Book <${process.env.EMAIL_SUPPORT_FROM_ADDRESS}>`,
        to: [email],
        subject: template.subject,
        body: template.message,
      });
    } catch (err) {
      logger.error('Email sending error:', err);
    }
    */

    return _.pick(newUser, UserClass.publicFields());
  }
}

mongoSchema.loadClass(UserClass);

const User = mongoose.model("User", mongoSchema);

export default User;
