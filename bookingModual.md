Perfect — based on your details, here’s a clean, Claude-ready Markdown explanation of the **Booking Module** for your system. I’ve structured it so Claude can read and ask follow-up questions if needed. No code included, just conceptual explanation.

---

# Booking Module Documentation

## Overview

The Booking Module allows **users** to book **services, packages, or promotions** offered by a business. Users can select available time slots to request a booking, and businesses have the ability to accept or reject these requests. Both users and businesses can view bookings with pagination and filtering options.

This module supports **concurrent clients**, cancellation, rescheduling, reminders, and status tracking.

---

## Booking Entities

1. **Service**

   * Defined by specific days and time intervals (`daySchedule`).
   * Each interval can have a **maximum number of concurrent clients**.
   * Users select a slot based on availability.

2. **Package**

   * Similar to services, with predefined schedules and concurrent client limits.
   * Can consist of multiple sessions across different days.

3. **Promotion**

   * Promotions are linked to either a service or a package.
   * The booking of a promotion inherits the associated entity's time slots.

4. **Rules**

   * Users can book multiple entities, **but not in the same time slot**.
   * Time slots are never hidden; instead, each slot has a **status**:

     * Available
     * Full (concurrent clients reached)
     * Past (time has already passed)

---

## Time Slot Logic

* Each service or package has a weekly schedule with open/closed days and intervals.
* Promotions are booked **against an existing service or package**.
* A slot becomes unavailable if:

  * Its time has passed.
  * The maximum number of concurrent clients is reached.
* Users can select only **available slots** to request a booking.

---

## Booking Workflow

1. **User Request**

   * User selects a service, package, or promotion.
   * User chooses an available time slot.
   * User submits a booking request.

2. **Business Action**

   * Business receives the booking request.
   * Business can **accept** or **reject** the booking.

3. **Booking Statuses**

   * Pending (requested by user)
   * Accepted (business confirmed)
   * Rejected (business declined)
   * Completed (after session finished)
   * Cancelled (by user)

---

## User & Business Views

* Both users and businesses can view bookings.
* Pagination is supported.
* Filters include:

  * Booking date
  * Entity type (service, package, promotion)
  * Status (pending, accepted, rejected, completed, cancelled)
  * Any other relevant field (e.g., user name, business name)

---

## Cancellation & Rescheduling

* Users can cancel bookings.
* Future enhancement: support rescheduling with automatic slot availability check.

---

## Notifications & Reminders

* Businesses can send:

  * **Payment reminders** for accepted bookings.
  * **Slot reminders** to users before the session starts.
  * **Start session notifications** when a booking begins.

---

## Key Constraints

* No booking allowed in a **past time slot**.
* **Concurrent client limit** enforced for services and packages.
* Promotions cannot be booked independently; they must be linked to a service or package.

---

## Next Steps / Questions for Claude

* Should cancellation affect **slot availability immediately**?
* Should accepted bookings automatically **reserve the slot** for concurrent client calculation?
* Are there **business-specific rules** for maximum bookings per day or per user?
* Should reminders include **custom messages** or just standard notifications?

---

This document provides the **conceptual structure** of the booking module without diving into code. Claude can now review this, analyze existing schemas (like `daySchedule`), and ask further clarifying questions.

---

