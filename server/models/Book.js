import mongoose, { Schema } from "mongoose";
import _ from "lodash";
import frontmatter from "front-matter";

import { getCommits, getContent } from "../github";
import { charge as stripeCharge } from "../stripe";
import sendEmail from "../aws";
import logger from "../logs";
import generateSlug from "../utils/slugify";
import { subscribe } from "../mailchimp";

import Chapter from "./Chapter";
import User from "./User";
import Purchase from "./Purchase";
import getEmailTemplate from "./EmailTemplate";

const ROOT_URL =
  process.env.ROOT_URL || `http://localhost:${process.env.PORT || 8000}`;

const mongoSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
  },

  userId: {
    type: Schema.Types.ObjectId,
    required: true,
  },

  githubRepo: {
    type: String,
    required: true,
  },
  githubLastCommitSha: String,

  createdAt: {
    type: Date,
    required: true,
  },
  // price in dollars
  price: {
    type: Number,
    required: true,
  },

  isInPreorder: {
    type: Boolean,
    defaultValue: false,
  },
  preorderPrice: Number,

  supportURL: String,
});

class BookClass {
  static async list({ userId }) {
    const allBooks = await this.find().sort({ createdAt: -1 });

    let books = [];
    const otherBooks = [];

    if (process.env.DEMO) {
      allBooks.forEach((b) => {
        if (b.userId && b.userId.equals(userId)) {
          books.push(b);
        } else {
          otherBooks.push(b);
        }
      });
    } else {
      books = allBooks;
    }

    return { books, otherBooks };
  }

  static async getPurchasedBooks({ purchasedBookIds, freeBookIds }) {
    const allBooks = await this.find().sort({ createdAt: -1 });

    const purchasedBooks = [];
    const freeBooks = [];
    const otherBooks = [];

    allBooks.forEach((b) => {
      if (purchasedBookIds.includes(b.id)) {
        purchasedBooks.push(b);
      } else if (freeBookIds.includes(b.id)) {
        freeBooks.push(b);
      } else {
        otherBooks.push(b);
      }
    });

    return { purchasedBooks, freeBooks, otherBooks };
  }

  static async getBySlug({ slug, userId }) {
    const bookDoc = await this.findOne({ slug });
    if (!bookDoc) {
      throw new Error("Book not found");
    }

    const book = bookDoc.toObject();

    book.chapters = (
      await Chapter.find({ bookId: book._id }, "title slug").sort({
        order: 1,
      })
    ).map((ch) => ch.toObject());

    if (userId) {
      const purchase = await Purchase.findOne(
        { userId, bookId: book._id },
        "doneChapterIds"
      );

      book.isPurchased = !!purchase;

      if (purchase && purchase.doneChapterIds) {
        book.chapters.forEach((ch) => {
          Object.assign(ch, {
            isFinished: _.some(purchase.doneChapterIds, (id) =>
              id.equals(ch._id)
            ),
          });
        });
      }
    }

    return book;
  }

  static async add({
    name,
    userId,
    price,
    githubRepo,
    supportURL = "",
    isInPreorder = null,
    preorderPrice = null,
  }) {
    if (process.env.DEMO) {
      const bookCount = await this.find({ userId }).count();
      if (bookCount > 0) {
        throw new Error("Demo account can create only one book");
      }
    }

    const slug = await generateSlug(this, name);

    return this.create({
      name,
      userId,
      slug,
      price,
      githubRepo,
      supportURL,
      isInPreorder,
      preorderPrice,
      createdAt: new Date(),
    });
  }

  static async edit({
    id,
    userId,
    name,
    price,
    githubRepo,
    supportURL = "",
    isInPreorder = null,
    preorderPrice = null,
  }) {
    const book = await this.findById(id, "slug name userId");

    if (!book) {
      throw new Error("Not found");
    }

    if (process.env.DEMO && (!book.userId || !book.userId.equals(userId))) {
      throw new Error("Permission denied");
    }

    const modifier = {
      price,
      supportURL,
      githubRepo,
      isInPreorder,
      preorderPrice,
    };

    if (name !== book.name) {
      modifier.name = name;
      modifier.slug = await generateSlug(this, name);
    }

    return this.updateOne({ _id: id }, { $set: modifier });
  }

  static async syncContent({ id, userId, githubAccessToken }) {
    const book = await this.findById(
      id,
      "userId githubRepo githubLastCommitSha"
    );

    if (!book) {
      throw new Error("Not found");
    }

    if (process.env.DEMO && (!book.userId || !book.userId.equals(userId))) {
      throw new Error("Permission denied");
    }

    const lastCommit = await getCommits({
      accessToken: githubAccessToken,
      repoName: book.githubRepo,
      limit: 1,
    });

    if (!lastCommit || !lastCommit.data || !lastCommit.data[0]) {
      throw new Error("No change!");
    }

    const lastCommitSha = lastCommit.data[0].sha;
    if (lastCommitSha === book.githubLastCommitSha) {
      throw new Error("No change!");
    }

    const mainFolder = await getContent({
      accessToken: githubAccessToken,
      repoName: book.githubRepo,
      path: "",
    });

    await Promise.all(
      mainFolder.data.map(async (f) => {
        if (f.type !== "file") {
          return;
        }

        if (f.path !== "introduction.md" && !/chapter-(\d+)\.md/.test(f.path)) {
          // not chapter content, skip
          return;
        }

        const chapter = await getContent({
          accessToken: githubAccessToken,
          repoName: book.githubRepo,
          path: f.path,
        });

        const data = frontmatter(
          Buffer.from(chapter.data.content, "base64").toString("utf8")
        );
        data.path = f.path;

        try {
          await Chapter.syncContent({ book, data });
          logger.info("Content is synced", { path: f.path });
        } catch (error) {
          logger.error("Content sync has error", { path: f.path, error });
        }
      })
    );

    return book.update({ githubLastCommitSha: lastCommitSha });
  }

  static async buy({ id, user, stripeToken }) {
    const book = await this.findById(
      id,
      "name slug price isInPreorder preorderPrice"
    );
    if (!book) {
      throw new Error("Book not found");
    }

    const isPreorder = !!book.isInPreorder && !!book.preorderPrice;
    const price = (isPreorder && book.preorderPrice) || book.price;

    if (!user) {
      throw new Error("User required");
    }

    const isPurchased =
      (await Purchase.find({ userId: user._id, bookId: id }).count()) > 0;
    if (isPurchased) {
      throw new Error("Already bought this book");
    }

    const chargeObj = await stripeCharge({
      amount: price * 100,
      token: stripeToken.id,
      bookName: book.name,
      buyerEmail: user.email,
    });

    User.findByIdAndUpdate(user.id, {
      $addToSet: { purchasedBookIds: book.id },
    }).exec();

    getEmailTemplate(isPreorder ? "preorder" : "purchase", {
      userName: user.displayName,
      bookTitle: book.name,
      bookUrl: `${ROOT_URL}/books/${book.slug}/introduction`,
    })
      .then((template) =>
        sendEmail({
          from: `Builder Book <${process.env.EMAIL_SUPPORT_FROM_ADDRESS}>`,
          to: [user.email],
          subject: template.subject,
          body: template.message,
        })
      )
      .catch((error) => {
        logger.error("Email sending error:", error);
      });

    if (!process.env.DEMO) {
      subscribe({
        email: user.email,
        listName: isPreorder ? "preordered" : "ordered",
        book: book.slug,
      }).catch((error) => {
        logger.error("Mailchimp subscribing error:", error);
      });
    }

    return Purchase.create({
      userId: user._id,
      bookId: book._id,
      amount: price * 100,
      createdAt: new Date(),
      stripeCharge: chargeObj,

      isPreorder,
    });
  }

  static async giveFree({ id, userId }) {
    const book = await this.findById(id, "id");
    if (!book) {
      throw new Error("Book not found");
    }

    if (!userId) {
      throw new Error("User ID required");
    }

    const isPurchased =
      (await Purchase.find({ userId, bookId: id }).count()) > 0;
    if (isPurchased) {
      throw new Error("Already bought this book");
    }

    User.findByIdAndUpdate(userId, {
      $addToSet: { freeBookIds: book.id },
    }).exec();

    return Purchase.create({
      userId,
      bookId: book._id,
      amount: 0,
      createdAt: new Date(),
      isFree: true,
    });
  }

  static async getPreorderedUsersEmail(bookId) {
    const preorders = await Purchase.find(
      { bookId, isPreorder: true },
      "userId"
    );
    const users = await User.find(
      { _id: { $in: preorders.map((p) => p.userId) } },
      "email"
    );

    return users.map((u) => u.email);
  }
}

mongoSchema.loadClass(BookClass);

const Book = mongoose.model("Book", mongoSchema);

export default Book;
