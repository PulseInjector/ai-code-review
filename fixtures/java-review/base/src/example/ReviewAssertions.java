package example;

public final class ReviewAssertions {
  public static void main(String[] args) {
    OrderSummary summary = new OrderSummary();
    if (summary.itemCount("active") != 2 || summary.itemCount("missing") != 0) {
      throw new AssertionError("order counts changed");
    }
    System.out.println("java-review-ok");
  }
}
