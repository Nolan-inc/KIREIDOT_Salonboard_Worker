alter table public.salonboard_sync_jobs
  drop constraint if exists salonboard_sync_jobs_job_type_check;

alter table public.salonboard_sync_jobs
  add constraint salonboard_sync_jobs_job_type_check
  check (
    job_type = any (
      array[
        'fetch_bookings'::text,
        'fetch_sales'::text,
        'push_booking'::text,
        'cancel_booking'::text,
        'push_blog'::text,
        'delete_blog'::text,
        'push_photo_gallery'::text,
        'delete_photo_gallery'::text,
        'push_review_reply'::text,
        'push_shifts'::text,
        'fetch_shifts'::text,
        'fetch_shift_patterns'::text,
        'fetch_staff'::text,
        'fetch_equipment'::text,
        'fetch_reviews'::text,
        'fetch_menu'::text,
        'fetch_coupon'::text,
        'fetch_blog'::text,
        'fetch_photo_gallery'::text,
        'fetch_salon'::text,
        'push_staff'::text,
        'push_menu'::text,
        'push_coupon'::text,
        'push_equipment'::text,
        'push_shift_patterns'::text,
        'fetch_salon_list'::text,
        'fetch_kodawari'::text,
        'fetch_feature'::text,
        'fetch_style'::text,
        'discover_listing'::text,
        'push_salon'::text,
        'push_kodawari'::text,
        'push_feature'::text,
        'push_acceptance'::text,
        'configure_notice_mail'::text
      ]
    )
  );
